import { Injectable, Logger } from '@nestjs/common';

import { DialogContextService } from '../orchestrator/dialog.context.js';

/**
 * Output envelope of `ClaudeService.handleTurn` — the upstream LLM caller
 * receives a system prompt augmented with LTM context (see
 * `DialogContextService.buildSystemPrompt`) and the raw user message. The
 * `reply` field is currently a deterministic placeholder; the actual LLM
 * round-trip lives behind Model Connector and lands in a follow-up task
 * (`ARCA-* — Claude completion path live wiring`). What matters for ARCA-0101
 * V-AC-14 is that **every** dialog turn invokes
 * `DialogContextService.buildSystemPrompt` — verified in unit + integration
 * spec under `chat.service.spec.ts`.
 */
export interface DialogTurnResult {
  /** Composed `systemPrefix + LTM block`, ready for upstream LLM. */
  systemPrompt: string;
  /** Original user utterance verbatim. */
  userMessage: string;
  /** Placeholder reply — replaced with LLM output by future Phase 7 task. */
  reply: string;
  /** Whether the LTM RAG block contributed content (false when Scrutator CB open). */
  ragApplied: boolean;
}

export interface DialogTurnOptions {
  /** Plain-text system prefix prepended before the RAG block. */
  systemPrefix?: string;
  /** Maximum LTM hits to inject. Defaults to DialogContextService default (5). */
  maxHits?: number;
  /** Minimum score (0..1) to include a hit. Defaults to DialogContextService default (0.1). */
  minScore?: number;
}

const PLACEHOLDER_REPLY = 'Принял. Полный ответ от Claude появится после ARCA-* Phase 7 wire-up.';
const DEFAULT_SYSTEM_PREFIX =
  'Ты — Arcanada Assistant. Отвечай по-русски, опирайся на воспоминания, если они релевантны.';

/**
 * `ClaudeService` is the canonical seam through which every Telegram /
 * Web dialog turn flows. Closes **V-AC-14** (ARCA-0101): on every turn it
 * calls `DialogContextService.buildSystemPrompt(userId, userMessage, …)` so
 * LTM recall is always merged into the system prompt — no caller can bypass
 * dialog context by calling `dialogContext` directly because the dialog
 * pipeline goes through this service.
 */
@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);

  constructor(private readonly dialogContext: DialogContextService) {}

  async handleTurn(
    userId: number,
    userMessage: string,
    options: DialogTurnOptions = {},
  ): Promise<DialogTurnResult> {
    if (!userMessage || userMessage.trim().length === 0) {
      this.logger.debug({ userId }, 'claude_turn_skip:empty_user_message');
      return {
        systemPrompt: options.systemPrefix ?? DEFAULT_SYSTEM_PREFIX,
        userMessage,
        reply: '',
        ragApplied: false,
      };
    }
    const systemPrefix = options.systemPrefix ?? DEFAULT_SYSTEM_PREFIX;
    const systemPrompt = await this.dialogContext.buildSystemPrompt(userId, userMessage, {
      systemPrefix,
      ...(options.maxHits !== undefined ? { maxHits: options.maxHits } : {}),
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
    });
    const ragApplied = systemPrompt.length > systemPrefix.length;
    this.logger.debug(
      { userId, systemPromptLength: systemPrompt.length, ragApplied },
      'claude_turn:dialog_context_applied',
    );
    return {
      systemPrompt,
      userMessage,
      reply: PLACEHOLDER_REPLY,
      ragApplied,
    };
  }
}
