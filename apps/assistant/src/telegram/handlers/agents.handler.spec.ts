import { describe, expect, it, vi } from 'vitest';

import type { TelegramGateway } from '../../webhook/telegram.gateway.js';
import type { OrchestratorService } from '../../orchestrator/orchestrator.service.js';
import type { OpsAgentResult } from '../../agents/ops-agent/ops-agent.service.js';

import { AgentsHandler } from './agents.handler.js';

function makeDeps(routeImpl: () => Promise<unknown>) {
  const send = vi.fn().mockResolvedValue(undefined);
  const orchestrator = { route: vi.fn(routeImpl) } as unknown as OrchestratorService;
  const gateway: TelegramGateway = { sendMessage: send };
  return { send, orchestrator, gateway };
}

describe('AgentsHandler', () => {
  it('reports agent count and timestamp', async () => {
    const { send, orchestrator, gateway } = makeDeps(
      async () =>
        ({
          kind: 'agents',
          count: 5,
          parsed_at: '2026-05-09T22:00:00.000Z',
        }) satisfies OpsAgentResult,
    );
    const handler = new AgentsHandler(orchestrator, gateway);
    await handler.handle(99);
    expect(send.mock.calls[0][0]).toBe(99);
    expect(send.mock.calls[0][1]).toContain('5');
  });

  it('warns when ops bot is unavailable', async () => {
    const { send, orchestrator, gateway } = makeDeps(
      async () => ({ kind: 'unavailable', reason: 'cb' }) satisfies OpsAgentResult,
    );
    const handler = new AgentsHandler(orchestrator, gateway);
    await handler.handle(10);
    expect(send.mock.calls[0][1]).toMatch(/недоступен/i);
  });
});
