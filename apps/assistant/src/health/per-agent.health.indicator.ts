import { Injectable } from '@nestjs/common';

import { AgentRegistry } from '../orchestrator/agent.registry.js';
import {
  isAgentHealth,
  type AgentHealthSnapshot,
} from '../aal/agent-health.types.js';

export interface MeshHealthRollup {
  status: 'ok' | 'degraded' | 'fail';
  agents: AgentHealthSnapshot[];
}

@Injectable()
export class PerAgentHealthIndicator {
  constructor(private readonly registry: AgentRegistry) {}

  async snapshot(): Promise<MeshHealthRollup> {
    const agents = this.registry.list();
    const snapshots = await Promise.all(
      agents.map(async (agent) => {
        if (isAgentHealth(agent)) {
          try {
            return await agent.healthSnapshot();
          } catch (err) {
            return {
              agent: agent.name,
              state: 'unavailable' as const,
              reason: err instanceof Error ? err.message : String(err),
              checkedAt: new Date().toISOString(),
            };
          }
        }
        return {
          agent: agent.name,
          state: 'ok' as const,
          checkedAt: new Date().toISOString(),
        };
      }),
    );

    const status = rollupStatus(snapshots);
    return { status, agents: snapshots };
  }
}

function rollupStatus(snapshots: AgentHealthSnapshot[]): MeshHealthRollup['status'] {
  if (snapshots.some((s) => s.state === 'unavailable')) return 'fail';
  if (snapshots.some((s) => s.state === 'degraded')) return 'degraded';
  return 'ok';
}
