import { describe, expect, it, vi } from 'vitest';
import type { EcosystemSnapshot } from '@arcanada/core';

import type { TelegramGateway } from '../../webhook/telegram.gateway.js';
import {
  NoAgentForIntentError,
  type OrchestratorService,
} from '../../orchestrator/orchestrator.service.js';
import type { OpsAgentResult } from '../../agents/ops-agent/ops-agent.service.js';

import { StatusHandler } from './status.handler.js';

const SNAPSHOT: EcosystemSnapshot = {
  agents_total: 3,
  events_total: 9,
  approvals_pending: 0,
  parsed_at: '2026-05-09T22:00:00.000Z',
};

function makeDeps(routeImpl: () => Promise<unknown>) {
  const send = vi.fn().mockResolvedValue(undefined);
  const orchestrator = { route: vi.fn(routeImpl) } as unknown as OrchestratorService;
  const gateway: TelegramGateway = { sendMessage: send };
  return { send, orchestrator, gateway };
}

describe('StatusHandler', () => {
  it('renders snapshot data and sends to chat', async () => {
    const { send, orchestrator, gateway } = makeDeps(async () =>
      ({ kind: 'status', snapshot: SNAPSHOT } satisfies OpsAgentResult),
    );
    const handler = new StatusHandler(orchestrator, gateway);
    await handler.handle(42);
    expect(send).toHaveBeenCalledTimes(1);
    const [chatId, text] = send.mock.calls[0];
    expect(chatId).toBe(42);
    expect(text).toContain('Агенты');
    expect(text).toContain('3');
    expect(text).toContain('Событий');
    expect(text).toContain('9');
  });

  it('warns when ops bot is unavailable (CB open)', async () => {
    const { send, orchestrator, gateway } = makeDeps(async () =>
      ({ kind: 'unavailable', reason: 'cb' } satisfies OpsAgentResult),
    );
    const handler = new StatusHandler(orchestrator, gateway);
    await handler.handle(7);
    expect(send.mock.calls[0][1]).toMatch(/недоступен/i);
  });

  it('replies with friendly fallback when no agent registered', async () => {
    const { send, orchestrator, gateway } = makeDeps(async () => {
      throw new NoAgentForIntentError('/status');
    });
    const handler = new StatusHandler(orchestrator, gateway);
    await handler.handle(1);
    expect(send.mock.calls[0][1]).toMatch(/недоступн|отключен/i);
  });
});
