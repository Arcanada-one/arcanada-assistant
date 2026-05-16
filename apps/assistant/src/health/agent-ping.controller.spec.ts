import { NotFoundException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { AgentRegistry, type IAgent } from '../orchestrator/agent.registry.js';
import type { IAgentHealth } from '../aal/agent-health.types.js';

import { AgentPingController } from './agent-ping.controller.js';

function makeReply(): { reply: FastifyReply; status: ReturnType<typeof vi.fn> } {
  const status = vi.fn().mockImplementation(() => reply);
  const reply = { status } as unknown as FastifyReply;
  return { reply, status };
}

function registerHealthy(name: string): AgentRegistry {
  const reg = new AgentRegistry();
  const agent: IAgent & IAgentHealth = {
    name,
    intents: [`/${name}`],
    async execute() {
      return null;
    },
    healthSnapshot() {
      return {
        agent: name,
        state: 'ok',
        circuit: 'closed',
        checkedAt: '2026-05-17T00:00:00Z',
      };
    },
  };
  reg.register(agent);
  return reg;
}

describe('AgentPingController', () => {
  it('returns 200 + snapshot for a healthy registered agent', async () => {
    const reg = registerHealthy('transcriber');
    const ctl = new AgentPingController(reg);
    const { reply, status } = makeReply();
    const out = await ctl.ping('transcriber', reply);
    expect(out.agent).toBe('transcriber');
    expect(out.state).toBe('ok');
    expect(status).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for malformed agent names (path injection guard)', async () => {
    const reg = registerHealthy('transcriber');
    const ctl = new AgentPingController(reg);
    const { reply } = makeReply();
    await expect(ctl.ping('../etc/passwd', reply)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.ping('CapsName', reply)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.ping('with.dot', reply)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.ping('', reply)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFoundException when agent is well-formed but not registered', async () => {
    const reg = registerHealthy('transcriber');
    const ctl = new AgentPingController(reg);
    const { reply } = makeReply();
    await expect(ctl.ping('unknown-agent', reply)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns synthetic ok for an agent without IAgentHealth', async () => {
    const reg = new AgentRegistry();
    reg.register({
      name: 'stub',
      intents: ['/stub'],
      async execute() {
        return null;
      },
    } as IAgent);
    const ctl = new AgentPingController(reg);
    const { reply, status } = makeReply();
    const out = await ctl.ping('stub', reply);
    expect(out.state).toBe('ok');
    expect(status).not.toHaveBeenCalled();
  });

  it('sets 207 when snapshot state is degraded', async () => {
    const reg = new AgentRegistry();
    reg.register({
      name: 'dreamer',
      intents: ['/dreamer/index_page'],
      async execute() {
        return null;
      },
      healthSnapshot() {
        return {
          agent: 'dreamer',
          state: 'degraded',
          reason: 'skeleton',
          checkedAt: 'now',
        };
      },
    } as IAgent & IAgentHealth);
    const ctl = new AgentPingController(reg);
    const { reply, status } = makeReply();
    await ctl.ping('dreamer', reply);
    expect(status).toHaveBeenCalledWith(207);
  });

  it('sets 503 when snapshot state is unavailable', async () => {
    const reg = new AgentRegistry();
    reg.register({
      name: 'munera',
      intents: ['/task_get'],
      async execute() {
        return null;
      },
      healthSnapshot() {
        return {
          agent: 'munera',
          state: 'unavailable',
          circuit: 'open',
          checkedAt: 'now',
        };
      },
    } as IAgent & IAgentHealth);
    const ctl = new AgentPingController(reg);
    const { reply, status } = makeReply();
    await ctl.ping('munera', reply);
    expect(status).toHaveBeenCalledWith(503);
  });
});
