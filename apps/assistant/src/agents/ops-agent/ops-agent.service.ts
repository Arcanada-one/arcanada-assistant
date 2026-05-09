import { Inject, Injectable } from '@nestjs/common';
import type { EcosystemSnapshot, IOpsBotClient } from '@arcanada/core';

import type { IAgent } from '../../orchestrator/agent.registry.js';

export const OPS_BOT_CLIENT = Symbol.for('OPS_BOT_CLIENT');

export type OpsAgentResult =
  | { kind: 'status'; snapshot: EcosystemSnapshot }
  | { kind: 'agents'; count: number; parsed_at: string }
  | { kind: 'unavailable'; reason: string };

@Injectable()
export class OpsAgentService implements IAgent {
  readonly name = 'ops';
  readonly intents = ['/status', '/agents'] as const;

  constructor(@Inject(OPS_BOT_CLIENT) private readonly client: IOpsBotClient) {}

  async execute(intent: string): Promise<OpsAgentResult> {
    if (this.client.isCircuitOpen()) {
      return { kind: 'unavailable', reason: 'ops_bot_circuit_open' };
    }
    if (intent === '/status') {
      const snapshot = await this.client.getEcosystemSnapshot();
      return { kind: 'status', snapshot };
    }
    if (intent === '/agents') {
      const snapshot = await this.client.getEcosystemSnapshot();
      return { kind: 'agents', count: snapshot.agents_total, parsed_at: snapshot.parsed_at };
    }
    throw new Error(`OpsAgent does not handle intent "${intent}"`);
  }
}
