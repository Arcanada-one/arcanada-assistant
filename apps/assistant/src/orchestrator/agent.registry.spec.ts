import { describe, it, expect } from 'vitest';

import { AgentRegistry, type IAgent } from './agent.registry.js';

const echoAgent: IAgent = {
  name: 'echo',
  intents: ['/echo'],
  async execute(intent: string, payload: unknown) {
    return { intent, payload };
  },
};

const opsAgent: IAgent = {
  name: 'ops',
  intents: ['/status', '/agents'],
  async execute() {
    return 'ok';
  },
};

describe('AgentRegistry', () => {
  it('registers an agent and resolves by intent', () => {
    const reg = new AgentRegistry();
    reg.register(opsAgent);
    expect(reg.resolve('/status')).toBe(opsAgent);
    expect(reg.resolve('/agents')).toBe(opsAgent);
  });

  it('returns undefined for unknown intent', () => {
    const reg = new AgentRegistry();
    reg.register(echoAgent);
    expect(reg.resolve('/missing')).toBeUndefined();
  });

  it('lists every registered agent without duplicates', () => {
    const reg = new AgentRegistry();
    reg.register(echoAgent);
    reg.register(opsAgent);
    expect(reg.list().map((a) => a.name).sort()).toEqual(['echo', 'ops']);
  });

  it('refuses to register two agents claiming the same intent', () => {
    const reg = new AgentRegistry();
    reg.register(opsAgent);
    expect(() =>
      reg.register({ name: 'shadow', intents: ['/status'], execute: async () => null }),
    ).toThrow(/already registered/i);
  });
});
