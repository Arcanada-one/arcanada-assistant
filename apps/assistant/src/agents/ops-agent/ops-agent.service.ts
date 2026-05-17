import { Inject, Injectable } from '@nestjs/common';
import {
  ExecuteCommandInputSchema,
  type EcosystemSnapshot,
  type ExecuteCommandInput,
  type IOpsBotClient,
} from '@arcanada/core';

import type { IAgent } from '../../orchestrator/agent.registry.js';

export const OPS_BOT_CLIENT = Symbol.for('OPS_BOT_CLIENT');

export const OPS_INTENT_STATUS = '/status';
export const OPS_INTENT_AGENTS = '/agents';
export const OPS_INTENT_OPSBOT_COMMAND = '/opsbot_command';

export type OpsAgentResult =
  | { kind: 'status'; snapshot: EcosystemSnapshot }
  | { kind: 'agents'; count: number; parsed_at: string }
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'command_ok';
      command_id: string;
      result?: Record<string, unknown>;
      executed_at: string;
    }
  | {
      kind: 'command_failed';
      reason: string;
      detail?: string;
      command_id?: string;
    };

@Injectable()
export class OpsAgentService implements IAgent {
  readonly name = 'ops';
  readonly intents = [
    OPS_INTENT_STATUS,
    OPS_INTENT_AGENTS,
    OPS_INTENT_OPSBOT_COMMAND,
  ] as const;

  constructor(@Inject(OPS_BOT_CLIENT) private readonly client: IOpsBotClient) {}

  async execute(intent: string, payload?: unknown): Promise<OpsAgentResult> {
    if (this.client.isCircuitOpen()) {
      return { kind: 'unavailable', reason: 'ops_bot_circuit_open' };
    }
    if (intent === OPS_INTENT_STATUS) {
      const snapshot = await this.client.getEcosystemSnapshot();
      return { kind: 'status', snapshot };
    }
    if (intent === OPS_INTENT_AGENTS) {
      const snapshot = await this.client.getEcosystemSnapshot();
      return { kind: 'agents', count: snapshot.agents_total, parsed_at: snapshot.parsed_at };
    }
    if (intent === OPS_INTENT_OPSBOT_COMMAND) {
      return this.runCommand(payload);
    }
    throw new Error(`OpsAgent does not handle intent "${intent}"`);
  }

  private async runCommand(payload: unknown): Promise<OpsAgentResult> {
    const parsed = ExecuteCommandInputSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        kind: 'command_failed',
        reason: 'opsbot_command_invalid_payload',
        detail: parsed.error.message,
      };
    }
    const input: ExecuteCommandInput = parsed.data;
    try {
      const response = await this.client.executeCommand(input);
      if (!response.ok) {
        return {
          kind: 'command_failed',
          reason: 'opsbot_command_rejected',
          command_id: response.command_id,
          detail: extractRejectionDetail(response.result),
        };
      }
      return {
        kind: 'command_ok',
        command_id: response.command_id,
        result: response.result,
        executed_at: response.executed_at,
      };
    } catch (err) {
      return {
        kind: 'command_failed',
        reason: 'opsbot_command_transport_error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function extractRejectionDetail(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return undefined;
  const reason = result.reason;
  return typeof reason === 'string' ? reason : undefined;
}
