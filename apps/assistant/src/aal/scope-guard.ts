import { Injectable, Logger } from '@nestjs/common';

import { AgentScopeError } from './exceptions.js';
import type { ScopeManifest } from './scope.schema.js';

/**
 * O(1) `(principal, agent, intent) → allow|deny` lookup. The manifest is
 * loaded once at boot. Default deny: any missing tuple throws
 * `AgentScopeError`.
 */
@Injectable()
export class ScopeGuard {
  private readonly logger = new Logger(ScopeGuard.name);
  private index = new Map<string, Set<string>>();
  private agentIndex = new Map<string, Set<string>>();

  load(manifest: ScopeManifest): void {
    const nextIntents = new Map<string, Set<string>>();
    const nextAgents = new Map<string, Set<string>>();
    for (const entry of manifest.scopes) {
      for (const agent of entry.agents) {
        const agentKey = `${entry.principal}::${agent.name}`;
        let agentSet = nextAgents.get(entry.principal);
        if (!agentSet) {
          agentSet = new Set<string>();
          nextAgents.set(entry.principal, agentSet);
        }
        agentSet.add(agent.name);
        const intentSet = nextIntents.get(agentKey) ?? new Set<string>();
        for (const intent of agent.intents) intentSet.add(intent);
        nextIntents.set(agentKey, intentSet);
      }
    }
    this.index = nextIntents;
    this.agentIndex = nextAgents;
    this.logger.log(
      `scope manifest loaded — ${manifest.scopes.length} principal(s), ${nextIntents.size} agent slot(s)`,
    );
  }

  isAllowed(principal: string, agent: string, intent: string): boolean {
    const set = this.index.get(`${principal}::${agent}`);
    return set?.has(intent) ?? false;
  }

  assertAllowed(principal: string, agent: string, intent: string): void {
    if (this.isAllowed(principal, agent, intent)) return;
    throw new AgentScopeError(
      `principal "${principal}" not allowed to invoke "${intent}" on "${agent}"`,
      { agent, intent, principal },
    );
  }

  listAgents(principal: string): string[] {
    return [...(this.agentIndex.get(principal) ?? [])];
  }

  listIntents(principal: string, agent: string): string[] {
    return [...(this.index.get(`${principal}::${agent}`) ?? [])];
  }
}
