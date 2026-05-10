import { Inject, Injectable } from '@nestjs/common';
import type { IScrutatorClient, SearchHit, RecallHit } from '@arcanada/core';

import type { IAgent } from '../../orchestrator/agent.registry.js';

export const SCRUTATOR_CLIENT = Symbol.for('SCRUTATOR_CLIENT');
export const SCRUTATOR_LTM_NAMESPACE = Symbol.for('SCRUTATOR_LTM_NAMESPACE');

export interface WikiHitRendered {
  chunkId: string;
  content: string;
  sourcePath: string;
  score: number;
  heading: string;
}

export interface RecallHitRendered {
  chunkId: string;
  content: string;
  score: number;
  sourcePath: string;
}

export type KnowledgeAgentResult =
  | { kind: 'wiki_hits'; hits: WikiHitRendered[]; query: string; searchTimeMs: number }
  | { kind: 'recall_hits'; hits: RecallHitRendered[]; query: string }
  | { kind: 'remembered'; namespace: string; async: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'unavailable'; reason: string; error?: string };

export interface WikiPayload {
  query: string;
}

export interface RememberPayload {
  text: string;
  userId: number;
}

export interface RecallPayload {
  query: string;
  userId: number;
}

const WIKI_NAMESPACE = 'arcanada';
const WIKI_LIMIT = 5;
const WIKI_MIN_SCORE = 0.01;
const RECALL_LIMIT = 5;
const RECALL_MIN_SCORE = 0.1;

@Injectable()
export class KnowledgeAgentService implements IAgent {
  readonly name = 'knowledge';
  readonly intents = ['/wiki', '/remember', '/recall'] as const;

  constructor(
    @Inject(SCRUTATOR_CLIENT) private readonly client: IScrutatorClient,
    @Inject(SCRUTATOR_LTM_NAMESPACE) private readonly ltmNamespacePrefix: string,
  ) {}

  async execute(intent: string, payload?: unknown): Promise<KnowledgeAgentResult> {
    if (this.client.isCircuitOpen()) {
      return { kind: 'unavailable', reason: 'scrutator_circuit_open' };
    }
    if (intent === '/wiki') {
      return this.handleWiki(payload as WikiPayload);
    }
    if (intent === '/remember') {
      return this.handleRemember(payload as RememberPayload);
    }
    if (intent === '/recall') {
      return this.handleRecall(payload as RecallPayload);
    }
    throw new Error(`KnowledgeAgent does not handle intent "${intent}"`);
  }

  private async handleWiki(payload: WikiPayload): Promise<KnowledgeAgentResult> {
    const query = (payload?.query ?? '').trim();
    if (!query) {
      return { kind: 'text', text: 'Укажите поисковый запрос: /wiki <запрос>' };
    }
    try {
      const result = await this.client.searchWiki({
        query,
        namespace: WIKI_NAMESPACE,
        limit: WIKI_LIMIT,
        min_score: WIKI_MIN_SCORE,
        include_content: true,
      });
      if (result.results.length === 0) {
        return { kind: 'text', text: `По запросу «${query}» ничего не найдено в вики.` };
      }
      return {
        kind: 'wiki_hits',
        hits: result.results.map((hit: SearchHit) => ({
          chunkId: hit.chunk_id,
          content: hit.content,
          sourcePath: hit.source_path,
          score: hit.score,
          heading: hit.heading_hierarchy?.[hit.heading_hierarchy.length - 1] ?? '',
        })),
        query: result.query,
        searchTimeMs: result.search_time_ms,
      };
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: 'scrutator_error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async handleRemember(payload: RememberPayload): Promise<KnowledgeAgentResult> {
    const text = (payload?.text ?? '').trim();
    if (!text) {
      return { kind: 'text', text: 'Укажите, что запомнить: /remember <текст>' };
    }
    if (!Number.isFinite(payload.userId)) {
      return { kind: 'unavailable', reason: 'missing_user_id' };
    }
    const namespace = this.userNamespace(payload.userId);
    try {
      const result = await this.client.ingestLtm({
        content: text,
        source_path: `telegram://user-memory/${payload.userId}`,
        namespace,
      });
      if (result.ok) {
        return { kind: 'remembered', namespace, async: result.async };
      }
      return {
        kind: 'unavailable',
        reason: 'scrutator_ingest_failed',
        ...(result.warning ? { error: result.warning } : {}),
      };
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: 'scrutator_error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async handleRecall(payload: RecallPayload): Promise<KnowledgeAgentResult> {
    const query = (payload?.query ?? '').trim();
    if (!query) {
      return { kind: 'text', text: 'Укажите запрос: /recall <запрос>' };
    }
    if (!Number.isFinite(payload.userId)) {
      return { kind: 'unavailable', reason: 'missing_user_id' };
    }
    const namespace = this.userNamespace(payload.userId);
    try {
      const result = await this.client.recallLtm({
        query,
        namespace,
        limit: RECALL_LIMIT,
        min_score: RECALL_MIN_SCORE,
      });
      if (result.results.length === 0) {
        return { kind: 'text', text: 'Ничего не вспомнил по этому запросу.' };
      }
      return {
        kind: 'recall_hits',
        hits: result.results.map((hit: RecallHit) => ({
          chunkId: hit.chunk_id,
          content: hit.content,
          score: hit.score,
          sourcePath: hit.source_path,
        })),
        query: result.query,
      };
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: 'scrutator_error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Server-derived namespace — payload userId only, never trust client-supplied namespace.
   * Format: `${ltmNamespacePrefix}:user:${userId}`.
   */
  private userNamespace(userId: number): string {
    return `${this.ltmNamespacePrefix}:user:${userId}`;
  }
}
