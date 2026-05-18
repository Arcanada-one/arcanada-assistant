import { Inject, Injectable, Optional } from '@nestjs/common';

import { TRACE_CONTEXT, type TraceContext } from '../observability/trace-context.js';

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
  constructor(
    private readonly registry: AgentRegistry,
    @Optional() @Inject(TRACE_CONTEXT) private readonly traceContext?: TraceContext,
  ) {}

  async route<T = unknown>(intent: string, payload?: unknown): Promise<T> {
    const agent = this.registry.resolve(intent);
    if (!agent) throw new NoAgentForIntentError(intent);

    if (!this.traceContext) {
      return (await agent.execute(intent, payload)) as T;
    }

    const span = this.traceContext.startSpan('orchestrator.route', {
      agent: agent.name,
      intent,
    });
    try {
      const result = (await agent.execute(intent, payload)) as T;
      span.setStatus('ok');
      return result;
    } catch (err) {
      span.setStatus('error', err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      span.end();
    }
  }

  describeAgents(): AgentSummary[] {
    return this.registry.list().map((a) => ({ name: a.name, intents: [...a.intents] }));
  }
}
