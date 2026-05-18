import { describe, it, expect, vi } from 'vitest';
import type { EcosystemSnapshot, ExecuteCommandResponse, IOpsBotClient } from '@arcanada/core';

import { OpsAgentService, OpsAgentResult } from './ops-agent.service.js';

const SNAPSHOT: EcosystemSnapshot = {
  agents_total: 4,
  events_total: 17,
  approvals_pending: 2,
  parsed_at: '2026-05-09T22:00:00.000Z',
};

const COMMAND_RESPONSE: ExecuteCommandResponse = {
  ok: true,
  command_id: '01J3K9Q2V4ZAB6X8Y0R2M5N7P9',
  result: { echo: { token: 'ARCA-0009' } },
  executed_at: '2026-05-17T20:30:00.000Z',
};

function mockClient(overrides: Partial<IOpsBotClient> = {}): IOpsBotClient {
  return {
    emitEvent: vi.fn(async () => ({ event_id: 'x', status: 'accepted' as const })),
    getEcosystemSnapshot: vi.fn(async () => SNAPSHOT),
    healthReady: vi.fn(async () => true),
    isCircuitOpen: vi.fn(() => false),
    executeCommand: vi.fn(async () => COMMAND_RESPONSE),
    ...overrides,
  };
}

describe('OpsAgentService', () => {
  it('declares /status, /agents, and /opsbot_command intents', () => {
    const agent = new OpsAgentService(mockClient());
    expect(agent.name).toBe('ops');
    expect([...agent.intents]).toEqual(['/status', '/agents', '/opsbot_command']);
  });

  it('handles /status by returning the full snapshot', async () => {
    const client = mockClient();
    const agent = new OpsAgentService(client);
    const result = (await agent.execute('/status')) as OpsAgentResult;
    expect(result.kind).toBe('status');
    if (result.kind === 'status') {
      expect(result.snapshot).toEqual(SNAPSHOT);
    }
    expect(client.getEcosystemSnapshot).toHaveBeenCalledTimes(1);
  });

  it('handles /agents by returning agent count from snapshot', async () => {
    const agent = new OpsAgentService(mockClient());
    const result = (await agent.execute('/agents')) as OpsAgentResult;
    expect(result.kind).toBe('agents');
    if (result.kind === 'agents') {
      expect(result.count).toBe(4);
    }
  });

  it('returns degraded result when circuit breaker is open', async () => {
    const client = mockClient({ isCircuitOpen: () => true });
    const agent = new OpsAgentService(client);
    const result = (await agent.execute('/status')) as OpsAgentResult;
    expect(result.kind).toBe('unavailable');
    expect(client.getEcosystemSnapshot).not.toHaveBeenCalled();
  });

  it('rejects unknown intents', async () => {
    const agent = new OpsAgentService(mockClient());
    await expect(agent.execute('/unknown')).rejects.toThrow(/does not handle/);
  });

  describe('/opsbot_command (M3, V-AC-3)', () => {
    it('forwards cmd + payload + idempotencyKey to client.executeCommand', async () => {
      const client = mockClient();
      const agent = new OpsAgentService(client);
      const result = (await agent.execute('/opsbot_command', {
        cmd: 'echo-back',
        payload: { token: 'ARCA-0009' },
        idempotencyKey: '018f8e2a-1c2d-7000-9000-000000000001',
      })) as OpsAgentResult;
      expect(result.kind).toBe('command_ok');
      if (result.kind === 'command_ok') {
        expect(result.command_id).toBe(COMMAND_RESPONSE.command_id);
        expect(result.result).toEqual({ echo: { token: 'ARCA-0009' } });
      }
      expect(client.executeCommand).toHaveBeenCalledWith({
        cmd: 'echo-back',
        payload: { token: 'ARCA-0009' },
        idempotencyKey: '018f8e2a-1c2d-7000-9000-000000000001',
      });
    });

    it('returns unavailable when circuit is open without calling client', async () => {
      const client = mockClient({ isCircuitOpen: () => true });
      const agent = new OpsAgentService(client);
      const result = (await agent.execute('/opsbot_command', {
        cmd: 'echo-back',
        payload: {},
        idempotencyKey: '018f8e2a-1c2d-7000-9000-000000000002',
      })) as OpsAgentResult;
      expect(result.kind).toBe('unavailable');
      expect(client.executeCommand).not.toHaveBeenCalled();
    });

    it('rejects invalid payload shape with command_failed result', async () => {
      const agent = new OpsAgentService(mockClient());
      const result = (await agent.execute('/opsbot_command', {
        // missing idempotencyKey
        cmd: 'echo-back',
        payload: {},
      })) as OpsAgentResult;
      expect(result.kind).toBe('command_failed');
    });

    it('maps client error to command_failed', async () => {
      const client = mockClient({
        executeCommand: vi.fn(async () => {
          throw new Error('opsbot down');
        }),
      });
      const agent = new OpsAgentService(client);
      const result = (await agent.execute('/opsbot_command', {
        cmd: 'echo-back',
        payload: {},
        idempotencyKey: '018f8e2a-1c2d-7000-9000-000000000003',
      })) as OpsAgentResult;
      expect(result.kind).toBe('command_failed');
      if (result.kind === 'command_failed') {
        expect(result.detail).toMatch(/opsbot down/);
      }
    });

    it('propagates ok:false from Ops Bot as command_failed', async () => {
      const client = mockClient({
        executeCommand: vi.fn(async () => ({
          ok: false,
          command_id: '01J3K9Q2V4ZAB6X8Y0R2M5N7P9',
          result: { reason: 'unsupported_command' },
          executed_at: '2026-05-17T20:30:00.000Z',
        })),
      });
      const agent = new OpsAgentService(client);
      const result = (await agent.execute('/opsbot_command', {
        cmd: 'echo-back',
        payload: {},
        idempotencyKey: '018f8e2a-1c2d-7000-9000-000000000004',
      })) as OpsAgentResult;
      expect(result.kind).toBe('command_failed');
    });
  });
});
