import { describe, it, expect, vi } from 'vitest';
import type { EcosystemSnapshot, IOpsBotClient } from '@arcanada/core';

import { OpsAgentService, OpsAgentResult } from './ops-agent.service.js';

const SNAPSHOT: EcosystemSnapshot = {
  agents_total: 4,
  events_total: 17,
  approvals_pending: 2,
  parsed_at: '2026-05-09T22:00:00.000Z',
};

function mockClient(overrides: Partial<IOpsBotClient> = {}): IOpsBotClient {
  return {
    emitEvent: vi.fn(async () => ({ event_id: 'x', status: 'accepted' as const })),
    getEcosystemSnapshot: vi.fn(async () => SNAPSHOT),
    healthReady: vi.fn(async () => true),
    isCircuitOpen: vi.fn(() => false),
    ...overrides,
  };
}

describe('OpsAgentService', () => {
  it('declares /status and /agents intents', () => {
    const agent = new OpsAgentService(mockClient());
    expect(agent.name).toBe('ops');
    expect([...agent.intents]).toEqual(['/status', '/agents']);
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
});
