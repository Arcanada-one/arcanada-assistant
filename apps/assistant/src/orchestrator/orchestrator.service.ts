import { Injectable } from '@nestjs/common';

import { AgentRegistry } from './agent.registry.js';

export class NoAgentForIntentError extends Error {
  constructor(readonly intent: string) {
    super(`No agent registered for intent "${intent}"`);
    this.name = 'NoAgentForIntentError';
  }
}

export interface AgentSummary {
  name: string;
  intents: string[];
}

@Injectable()
export class OrchestratorService {
  constructor(private readonly registry: AgentRegistry) {}

  async route<T = unknown>(intent: string, payload?: unknown): Promise<T> {
    const agent = this.registry.resolve(intent);
    if (!agent) throw new NoAgentForIntentError(intent);
    return (await agent.execute(intent, payload)) as T;
  }

  describeAgents(): AgentSummary[] {
    return this.registry.list().map((a) => ({ name: a.name, intents: [...a.intents] }));
  }
}
