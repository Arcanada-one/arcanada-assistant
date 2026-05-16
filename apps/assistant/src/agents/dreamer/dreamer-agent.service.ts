import { Inject, Injectable } from '@nestjs/common';

import type { IAgent } from '../../orchestrator/agent.registry.js';

import type { IDreamerClient } from './dreamer.client.js';
import {
  DREAMER_INTENT_INDEX_PAGE,
  DREAMER_INTENT_LINK_GRAPH,
  DREAMER_INTENT_SUMMARIZE,
  type DreamerResult,
  type IndexPageRequest,
  type LinkGraphRequest,
  type SummarizeRequest,
} from './dreamer.schemas.js';

export const DREAMER_CLIENT = Symbol.for('DREAMER_CLIENT');

@Injectable()
export class DreamerAgentService implements IAgent {
  readonly name = 'dreamer';
  readonly intents = [
    DREAMER_INTENT_INDEX_PAGE,
    DREAMER_INTENT_SUMMARIZE,
    DREAMER_INTENT_LINK_GRAPH,
  ] as const;

  constructor(@Inject(DREAMER_CLIENT) private readonly client: IDreamerClient) {}

  async execute(intent: string, payload?: unknown): Promise<DreamerResult> {
    if (!isObject(payload)) {
      return {
        kind: 'unavailable',
        reason: 'dreamer_invalid_payload',
        detail: 'payload must be an object matching the Dreamer schema',
      };
    }
    try {
      switch (intent) {
        case DREAMER_INTENT_INDEX_PAGE:
          return await this.client.indexPage(payload as IndexPageRequest);
        case DREAMER_INTENT_SUMMARIZE:
          return await this.client.summarize(payload as SummarizeRequest);
        case DREAMER_INTENT_LINK_GRAPH:
          return await this.client.linkGraph(payload as LinkGraphRequest);
        default:
          throw new Error(`DreamerAgent does not handle intent "${intent}"`);
      }
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: 'dreamer_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
