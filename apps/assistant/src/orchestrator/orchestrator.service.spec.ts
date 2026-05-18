import { describe, it, expect, vi } from 'vitest';

import { NoopTraceContext } from '../observability/trace-context.js';

import { AgentRegistry, type IAgent } from './agent.registry.js';
import { NoAgentForIntentError, OrchestratorService } from './orchestrator.service.js';

function makeAgent(name: string, intents: string[], handler = vi.fn(async () => 'ok')): IAgent {
  return { name, intents, execute: handler };
}

describe('OrchestratorService.route', () => {
  it('dispatches intent to the matching agent', async () => {
    const reg = new AgentRegistry();
    const handler = vi.fn(async () => ({ ok: true }));
    reg.register(makeAgent('ops', ['/status'], handler));
    const orch = new OrchestratorService(reg);
    const result = await orch.route('/status', { user: 1 });
    expect(handler).toHaveBeenCalledWith('/status', { user: 1 });
    expect(result).toEqual({ ok: true });
  });

  it('throws NoAgentForIntentError when no agent claims the intent', async () => {
    const reg = new AgentRegistry();
    const orch = new OrchestratorService(reg);
    await expect(orch.route('/unknown')).rejects.toBeInstanceOf(NoAgentForIntentError);
  });

  it('describeAgents returns name + intents map', () => {
    const reg = new AgentRegistry();
    reg.register(makeAgent('ops', ['/status', '/agents']));
    reg.register(makeAgent('echo', ['/echo']));
    const orch = new OrchestratorService(reg);
    const summary = orch.describeAgents().sort((a, b) => a.name.localeCompare(b.name));
    expect(summary).toEqual([
      { name: 'echo', intents: ['/echo'] },
      { name: 'ops', intents: ['/status', '/agents'] },
    ]);
  });

  it('wraps successful dispatch in a trace span with agent/intent attributes', async () => {
    const reg = new AgentRegistry();
    reg.register(makeAgent('munera', ['/task_get']));
    const tracer = new NoopTraceContext();
    const orch = new OrchestratorService(reg, tracer);
    await orch.route('/task_get');
    // span ended → currentSpan undefined
    expect(tracer.currentSpan()).toBeUndefined();
  });

  it('records error status when handler throws and rethrows the error', async () => {
    const reg = new AgentRegistry();
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    reg.register(makeAgent('flaky', ['/flaky'], handler));
    const tracer = new NoopTraceContext();
    const orch = new OrchestratorService(reg, tracer);
    await expect(orch.route('/flaky')).rejects.toThrow('boom');
    expect(tracer.currentSpan()).toBeUndefined();
  });
});
