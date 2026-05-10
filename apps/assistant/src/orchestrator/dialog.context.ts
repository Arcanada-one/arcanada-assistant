import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IScrutatorClient, RecallHit } from '@arcanada/core';

import {
  SCRUTATOR_CLIENT,
  SCRUTATOR_LTM_NAMESPACE,
} from '../agents/knowledge-agent/knowledge-agent.service.js';

export interface DialogContextOptions {
  /** Plain-text system prefix prepended before the RAG block. */
  systemPrefix?: string;
  /** Maximum LTM hits to inject. Defaults to 5. */
  maxHits?: number;
  /** Minimum score (0..1) to include a hit. Defaults to 0.1. */
  minScore?: number;
}

const DEFAULT_MAX_HITS = 5;
const DEFAULT_MIN_SCORE = 0.1;

/**
 * Builds Claude-friendly system prompts augmented with relevant LTM hits for
 * a given user. Soft-fails when Scrutator is unavailable — the dialog must
 * keep working even with zero recall.
 *
 * Wire this into the Claude completion path (next phase: ARCA-0009 dialog
 * flow) by calling `buildSystemPrompt` before sending the user turn.
 */
@Injectable()
export class DialogContextService {
  private readonly logger = new Logger(DialogContextService.name);

  constructor(
    @Inject(SCRUTATOR_CLIENT) private readonly scrutator: IScrutatorClient,
    @Inject(SCRUTATOR_LTM_NAMESPACE) private readonly ltmNamespacePrefix: string,
  ) {}

  async buildSystemPrompt(
    userId: number,
    userMessage: string,
    options: DialogContextOptions = {},
  ): Promise<string> {
    const parts: string[] = [];
    if (options.systemPrefix) parts.push(options.systemPrefix);

    const ragBlock = await this.recallSafe(userId, userMessage, options);
    if (ragBlock) parts.push(ragBlock);

    return parts.join('\n\n');
  }

  private async recallSafe(
    userId: number,
    userMessage: string,
    options: DialogContextOptions,
  ): Promise<string | null> {
    if (this.scrutator.isCircuitOpen()) {
      this.logger.warn({ userId }, 'rag_skipped:circuit_open');
      return '(Контекст долговременной памяти временно недоступен.)';
    }
    const namespace = `${this.ltmNamespacePrefix}:user:${userId}`;
    try {
      const result = await this.scrutator.recallLtm({
        query: userMessage,
        namespace,
        limit: options.maxHits ?? DEFAULT_MAX_HITS,
        min_score: options.minScore ?? DEFAULT_MIN_SCORE,
      });
      if (result.results.length === 0) {
        this.logger.debug({ userId, namespace }, 'rag_recall:empty');
        return null;
      }
      this.logger.debug(
        { userId, namespace, hits: result.results.length },
        'rag_recall:hit',
      );
      return formatMemoriesBlock(result.results);
    } catch (err) {
      this.logger.warn(
        { userId, namespace, err: err instanceof Error ? err.message : String(err) },
        'rag_skipped:error',
      );
      return '(Контекст долговременной памяти временно недоступен.)';
    }
  }
}

function formatMemoriesBlock(hits: RecallHit[]): string {
  const lines: string[] = ['<past_conversation_memories>'];
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    if (!hit) continue;
    lines.push(`[Memory ${i + 1}] (confidence: ${(hit.score * 100).toFixed(0)}%)`);
    lines.push(hit.content);
    if (i < hits.length - 1) lines.push('');
  }
  lines.push('</past_conversation_memories>');
  lines.push('');
  lines.push('При ответе учитывай эти воспоминания, если они релевантны запросу.');
  return lines.join('\n');
}
