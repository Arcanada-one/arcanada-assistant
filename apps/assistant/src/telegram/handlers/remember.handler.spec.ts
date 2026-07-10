import { describe, expect, it, vi } from 'vitest';

import type { TelegramGateway } from '../../webhook/telegram.gateway.js';
import type { OrchestratorService } from '../../orchestrator/orchestrator.service.js';
import { NoAgentForIntentError } from '../../orchestrator/orchestrator.service.js';
import type { KnowledgeAgentResult } from '../../agents/knowledge-agent/knowledge-agent.service.js';

import { RememberHandler } from './remember.handler.js';

function makeDeps(routeImpl: () => Promise<unknown>) {
  const send = vi.fn().mockResolvedValue(undefined);
  const orchestrator = { route: vi.fn(routeImpl) } as unknown as OrchestratorService;
  const gateway: TelegramGateway = { sendMessage: send };
  return { send, orchestrator, gateway };
}

describe('RememberHandler', () => {
  it('renders remembered (sync) with namespace', async () => {
    const { send, orchestrator, gateway } = makeDeps(async (): Promise<KnowledgeAgentResult> => ({
      kind: 'remembered',
      namespace: 'assistant:user:14128108',
      async: false,
    }));
    const handler = new RememberHandler(orchestrator, gateway);
    await handler.handle(99, 14128108, 'arcana-prod IP 65.108.236.39');
    expect(send.mock.calls[0][0]).toBe(99);
    const text = send.mock.calls[0][1] as string;
    expect(text).toMatch(/Запомнил/i);
    expect(text).toContain('assistant:user:14128108');
    expect(text).not.toContain('фоновая');
  });

  it('flags async ingest in user-facing message', async () => {
    const { send, orchestrator, gateway } = makeDeps(async (): Promise<KnowledgeAgentResult> => ({
      kind: 'remembered',
      namespace: 'assistant:user:1',
      async: true,
    }));
    const handler = new RememberHandler(orchestrator, gateway);
    await handler.handle(1, 1, 'fact');
    expect(send.mock.calls[0][1]).toContain('фоновая');
  });

  it('passes (text, userId) to orchestrator', async () => {
    const { orchestrator, gateway } = makeDeps(async (): Promise<KnowledgeAgentResult> => ({
      kind: 'remembered',
      namespace: 'assistant:user:42',
      async: false,
    }));
    const handler = new RememberHandler(orchestrator, gateway);
    await handler.handle(1, 42, 'hello');
    expect(orchestrator.route).toHaveBeenCalledWith('/remember', { text: 'hello', userId: 42 });
  });

  it('refuses without userId (cannot derive namespace)', async () => {
    const { send, orchestrator, gateway } = makeDeps(async () => {
      throw new Error('should not be called');
    });
    const handler = new RememberHandler(orchestrator, gateway);
    await handler.handle(1, undefined, 'fact');
    expect(orchestrator.route).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]).toMatch(/невозможно сохранить/i);
  });

  it('asks for content when text is empty', async () => {
    const { send, orchestrator, gateway } = makeDeps(async () => {
      throw new Error('should not be called');
    });
    const handler = new RememberHandler(orchestrator, gateway);
    await handler.handle(1, 1, '   ');
    expect(orchestrator.route).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]).toMatch(/Что запомнить/i);
  });

  it('warns when knowledge agent returns unavailable', async () => {
    const { send, orchestrator, gateway } = makeDeps(async (): Promise<KnowledgeAgentResult> => ({
      kind: 'unavailable',
      reason: 'scrutator_circuit_open',
    }));
    const handler = new RememberHandler(orchestrator, gateway);
    await handler.handle(1, 1, 'fact');
    expect(send.mock.calls[0][1]).toMatch(/Не удалось запомнить/i);
    expect(send.mock.calls[0][1]).toContain('scrutator_circuit_open');
  });

  it('says "временно отключена" when agent not registered', async () => {
    const { send, orchestrator, gateway } = makeDeps(async () => {
      throw new NoAgentForIntentError('/remember');
    });
    const handler = new RememberHandler(orchestrator, gateway);
    await handler.handle(1, 1, 'fact');
    expect(send.mock.calls[0][1]).toMatch(/временно отключена/i);
  });

  it('says fallback on unexpected error', async () => {
    const { send, orchestrator, gateway } = makeDeps(async () => {
      throw new Error('boom');
    });
    const handler = new RememberHandler(orchestrator, gateway);
    await handler.handle(1, 1, 'fact');
    expect(send.mock.calls[0][1]).toMatch(/Не удалось сохранить/i);
  });
});
