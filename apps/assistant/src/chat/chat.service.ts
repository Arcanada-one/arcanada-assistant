import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CLAUDE_CLIENT } from '../agents/claude/claude-agent.module.js';
import type { IClaudeClient } from '../agents/claude/claude.client.js';
import type { ClaudeContentBlock } from '../agents/claude/claude.schemas.js';
import { CLAUDE_CONFIG, type ClaudeConfig } from '../config/claude.config.js';
import { DialogContextService } from '../orchestrator/dialog.context.js';

/**
 * Output envelope of `ClaudeService.handleTurn`. Closes ARCA-0101 V-AC-14
 * (DialogContextService.buildSystemPrompt called on every turn) and now also
 * carries the real LLM reply when ARCA-0011 vision path is enabled.
 */
export interface DialogTurnResult {
  systemPrompt: string;
  /** Original user utterance verbatim (always a string — for multimodal turns
   * this is the concatenation of text blocks). */
  userMessage: string;
  /** LLM reply or RU fail-soft string when the Claude path is unavailable. */
  reply: string;
  ragApplied: boolean;
  /** Pino-friendly metadata for the modality-aware caller. */
  meta?: {
    model?: string;
    costUsd?: number;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface DialogTurnOptions {
  systemPrefix?: string;
  maxHits?: number;
  minScore?: number;
  /** Modality label for structured logs / metrics. */
  modality?: 'text' | 'voice' | 'photo' | 'document';
  /** Optional request id for tracing through MC. */
  requestId?: string;
}

export const PLACEHOLDER_REPLY =
  'Принял. Полный ответ от Claude появится после ARCA-* Phase 7 wire-up.';

export const CLAUDE_UNAVAILABLE_REPLY = '⚠️ Полный ответ от Claude недоступен.';

const DEFAULT_SYSTEM_PREFIX =
  'Ты — Arcanada Assistant. Отвечай по-русски, опирайся на воспоминания, если они релевантны.';

function extractText(content: string | ClaudeContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts = content
    .filter((b): b is Extract<ClaudeContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text);
  return parts.join('\n');
}

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);

  constructor(
    private readonly dialogContext: DialogContextService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() @Inject(CLAUDE_CLIENT) private readonly claude?: IClaudeClient,
  ) {}

  async handleTurn(
    userId: number,
    userMessage: string | ClaudeContentBlock[],
    options: DialogTurnOptions = {},
  ): Promise<DialogTurnResult> {
    const textForRag = extractText(userMessage);

    if (!textForRag || textForRag.trim().length === 0) {
      this.logger.debug({ userId }, 'claude_turn_skip:empty_user_message');
      return {
        systemPrompt: options.systemPrefix ?? DEFAULT_SYSTEM_PREFIX,
        userMessage: textForRag,
        reply: '',
        ragApplied: false,
      };
    }
    const systemPrefix = options.systemPrefix ?? DEFAULT_SYSTEM_PREFIX;
    const systemPrompt = await this.dialogContext.buildSystemPrompt(userId, textForRag, {
      systemPrefix,
      ...(options.maxHits !== undefined ? { maxHits: options.maxHits } : {}),
      ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
    });
    const ragApplied = systemPrompt.length > systemPrefix.length;
    this.logger.debug(
      { userId, systemPromptLength: systemPrompt.length, ragApplied, modality: options.modality },
      'claude_turn:dialog_context_applied',
    );

    const visionEnabled = this.config()?.visionEnabled === true;
    if (!visionEnabled || !this.claude) {
      return {
        systemPrompt,
        userMessage: textForRag,
        reply: PLACEHOLDER_REPLY,
        ragApplied,
      };
    }

    const completionRequest = {
      systemPrompt,
      content: userMessage,
      ...(options.requestId ? { requestId: options.requestId } : {}),
    };
    const result = await this.claude.complete(completionRequest);
    if (result.kind === 'unavailable') {
      this.logger.warn(
        { userId, reason: result.reason, modality: options.modality },
        'claude_turn:upstream_unavailable',
      );
      return {
        systemPrompt,
        userMessage: textForRag,
        reply: CLAUDE_UNAVAILABLE_REPLY,
        ragApplied,
      };
    }

    const costWarn = this.config()?.costWarnUsd ?? 0.1;
    if (result.costUsd > costWarn) {
      this.logger.warn(
        {
          userId,
          costUsd: result.costUsd,
          model: result.model,
          modality: options.modality,
        },
        'claude_turn:cost_above_warn',
      );
    }
    this.logger.log(
      {
        userId,
        modality: options.modality ?? 'text',
        model: result.model,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        success: true,
      },
      'claude_turn:ok',
    );

    return {
      systemPrompt,
      userMessage: textForRag,
      reply: result.reply,
      ragApplied,
      meta: {
        model: result.model,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    };
  }

  private config(): ClaudeConfig | undefined {
    if (!this.configService) return undefined;
    return this.configService.get<ClaudeConfig>(CLAUDE_CONFIG);
  }
}
