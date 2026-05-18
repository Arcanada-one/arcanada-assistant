import { describe, expect, it } from 'vitest';

import { AgentRegistry, type IAgent } from '../orchestrator/agent.registry.js';
import type { AgentHealthSnapshot, IAgentHealth } from '../aal/agent-health.types.js';

import { PerAgentHealthIndicator } from './per-agent.health.indicator.js';

function makeAgent(name: string, intents: string[], snapshot?: AgentHealthSnapshot): IAgent {
  const agent: IAgent & Partial<IAgentHealth> = {
    name,
    intents,
    async execute() {
      return null;
    },
  };
  if (snapshot) {
    (agent as IAgentHealth).healthSnapshot = () => snapshot;
  }
  return agent;
}

describe('PerAgentHealthIndicator', () => {
  it('reports ok when every agent implementing IAgentHealth is closed', async () => {
    const registry = new AgentRegistry();
    registry.register(
      makeAgent('transcriber', ['/transcribe'], {
        agent: 'transcriber',
        state: 'ok',
        circuit: 'closed',
        checkedAt: '2026-05-17T00:00:00Z',
      }),
    );
    registry.register(
      makeAgent('munera', ['/task_get'], {
        agent: 'munera',
        state: 'ok',
        circuit: 'closed',
        checkedAt: '2026-05-17T00:00:00Z',
      }),
    );

    const indicator = new PerAgentHealthIndicator(registry);
    const out = await indicator.snapshot();
    expect(out.status).toBe('ok');
    expect(out.agents).toHaveLength(2);
    expect(out.agents.map((a) => a.agent).sort()).toEqual(['munera', 'transcriber']);
  });

  it('rolls up to degraded when any agent is degraded', async () => {
    const registry = new AgentRegistry();
    registry.register(
      makeAgent('a', ['/a'], {
        agent: 'a',
        state: 'ok',
        circuit: 'closed',
        checkedAt: 'now',
      }),
    );
    registry.register(
      makeAgent('b', ['/b'], {
        agent: 'b',
        state: 'degraded',
        circuit: 'half-open',
        checkedAt: 'now',
      }),
    );
    const indicator = new PerAgentHealthIndicator(registry);
    const out = await indicator.snapshot();
    expect(out.status).toBe('degraded');
  });

  it('rolls up to fail when any agent is unavailable', async () => {
    const registry = new AgentRegistry();
    registry.register(
      makeAgent('a', ['/a'], {
        agent: 'a',
        state: 'ok',
        circuit: 'closed',
        checkedAt: 'now',
      }),
    );
    registry.register(
      makeAgent('b', ['/b'], {
        agent: 'b',
        state: 'unavailable',
        circuit: 'open',
        checkedAt: 'now',
      }),
    );
    const indicator = new PerAgentHealthIndicator(registry);
    const out = await indicator.snapshot();
    expect(out.status).toBe('fail');
  });

  it('reports synthetic ok for agents that do NOT implement IAgentHealth', async () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent('stub', ['/stub']));
    const indicator = new PerAgentHealthIndicator(registry);
    const out = await indicator.snapshot();
    expect(out.agents).toHaveLength(1);
    expect(out.agents[0]).toMatchObject({ agent: 'stub', state: 'ok' });
  });

  it('catches per-agent snapshot throws and reports unavailable instead of crashing', async () => {
    const registry = new AgentRegistry();
    const flaky: IAgent & IAgentHealth = {
      name: 'flaky',
      intents: ['/flaky'],
      async execute() {
        return null;
      },
      healthSnapshot(): never {
        throw new Error('boom');
      },
    };
    registry.register(flaky);
    const indicator = new PerAgentHealthIndicator(registry);
    const out = await indicator.snapshot();
    expect(out.status).toBe('fail');
    expect(out.agents[0]).toMatchObject({
      agent: 'flaky',
      state: 'unavailable',
      reason: 'boom',
    });
  });
});
