import { describe, expect, it, vi } from 'vitest';

import type { TelegramGateway } from '../../webhook/telegram.gateway.js';
import type { OrchestratorService } from '../../orchestrator/orchestrator.service.js';
import { NoAgentForIntentError } from '../../orchestrator/orchestrator.service.js';
import type { KnowledgeAgentResult } from '../../agents/knowledge-agent/knowledge-agent.service.js';

import { WikiHandler } from './wiki.handler.js';

function makeDeps(routeImpl: () => Promise<unknown>) {
  const send = vi.fn().mockResolvedValue(undefined);
  const orchestrator = { route: vi.fn(routeImpl) } as unknown as OrchestratorService;
  const gateway: TelegramGateway = { sendMessage: send };
  return { send, orchestrator, gateway };
}

describe('WikiHandler', () => {
  it('renders wiki_hits with snippet, source path, and search time', async () => {
    const { send, orchestrator, gateway } = makeDeps(async (): Promise<KnowledgeAgentResult> => ({
      kind: 'wiki_hits',
      query: 'Datarim',
      searchTimeMs: 168.4,
      hits: [
        {
          chunkId: 'c1',
          content: 'Datarim is a workflow framework for AI-assisted development',
          sourcePath: 'wiki/Datarim.md',
          score: 0.42,
          heading: '## Overview',
        },
      ],
    }));
    const handler = new WikiHandler(orchestrator, gateway);
    await handler.handle(99, 'Datarim');
    const [chatId, text] = send.mock.calls[0] as [number, string];
    expect(chatId).toBe(99);
    expect(text).toContain('Datarim');
    expect(text).toContain('wiki/Datarim.md');
    expect(text).toMatch(/168 мс|168 мс|168/);
    expect(text).toContain('## Overview');
    expect(text).toContain('42%');
  });

  it('passes query payload to orchestrator', async () => {
    const { orchestrator, gateway } = makeDeps(async (): Promise<KnowledgeAgentResult> => ({
      kind: 'text',
      text: 'noop',
    }));
    const handler = new WikiHandler(orchestrator, gateway);
    await handler.handle(1, 'hello world');
    expect(orchestrator.route).toHaveBeenCalledWith('/wiki', { query: 'hello world' });
  });

  it('renders text result directly (empty results case)', async () => {
    const { send, orchestrator, gateway } = makeDeps(async (): Promise<KnowledgeAgentResult> => ({
      kind: 'text',
      text: 'По запросу «xyz» ничего не найдено в вики.',
    }));
    const handler = new WikiHandler(orchestrator, gateway);
    await handler.handle(1, 'xyz');
    expect(send.mock.calls[0][1]).toContain('ничего не найдено');
  });

  it('warns when knowledge agent is unavailable', async () => {
    const { send, orchestrator, gateway } = makeDeps(async (): Promise<KnowledgeAgentResult> => ({
      kind: 'unavailable',
      reason: 'scrutator_circuit_open',
    }));
    const handler = new WikiHandler(orchestrator, gateway);
    await handler.handle(1, 'q');
    expect(send.mock.calls[0][1]).toMatch(/недоступен/i);
    expect(send.mock.calls[0][1]).toContain('scrutator_circuit_open');
  });

  it('says "временно отключена" when agent not registered', async () => {
    const { send, orchestrator, gateway } = makeDeps(async () => {
      throw new NoAgentForIntentError('/wiki');
    });
    const handler = new WikiHandler(orchestrator, gateway);
    await handler.handle(1, 'q');
    expect(send.mock.calls[0][1]).toMatch(/временно отключена/i);
  });

  it('says fallback when orchestrator throws unexpected error', async () => {
    const { send, orchestrator, gateway } = makeDeps(async () => {
      throw new Error('upstream-broken');
    });
    const handler = new WikiHandler(orchestrator, gateway);
    await handler.handle(1, 'q');
    expect(send.mock.calls[0][1]).toMatch(/Не удалось/i);
  });

  it('truncates long snippets at 240 chars with ellipsis', async () => {
    const long = 'a'.repeat(500);
    const { send, orchestrator, gateway } = makeDeps(async (): Promise<KnowledgeAgentResult> => ({
      kind: 'wiki_hits',
      query: 'q',
      searchTimeMs: 50,
      hits: [
        {
          chunkId: 'c1',
          content: long,
          sourcePath: 'wiki/long.md',
          score: 0.1,
          heading: '',
        },
      ],
    }));
    const handler = new WikiHandler(orchestrator, gateway);
    await handler.handle(1, 'q');
    const text = send.mock.calls[0][1] as string;
    expect(text).toContain('…');
    expect(text).not.toContain('a'.repeat(241));
  });
});
