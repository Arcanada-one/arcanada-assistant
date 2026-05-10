import { describe, it, expect, vi } from 'vitest';
import type { IScrutatorClient, RecallResult } from '@arcanada/core';

import { DialogContextService } from './dialog.context.js';

const RECALL_HIT: RecallResult = {
  results: [
    {
      chunk_id: 'm1',
      content: 'arcana-prod IP 65.108.236.39',
      source_path: 'telegram://user-memory/14128108',
      score: 0.91,
      namespace: 'assistant:user:14128108',
      project: null,
      metadata: {},
      entities: [],
      relations: [],
    },
    {
      chunk_id: 'm2',
      content: 'Vault primary on arcana-db:8200',
      source_path: 'telegram://user-memory/14128108',
      score: 0.55,
      namespace: 'assistant:user:14128108',
      project: null,
      metadata: {},
      entities: [],
      relations: [],
    },
  ],
  total: 2,
  query: 'IP',
  search_time_ms: 88,
};

const RECALL_EMPTY: RecallResult = { results: [], total: 0, query: '', search_time_ms: 0 };

function mockClient(overrides: Partial<IScrutatorClient> = {}): IScrutatorClient {
  return {
    ping: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
    searchWiki: vi.fn(async () => {
      throw new Error('unused');
    }),
    ingestLtm: vi.fn(async () => {
      throw new Error('unused');
    }),
    recallLtm: vi.fn(async () => RECALL_HIT),
    isCircuitOpen: vi.fn(() => false),
    ...overrides,
  };
}

describe('DialogContextService.buildSystemPrompt', () => {
  it('injects past_conversation_memories block when recall returns hits', async () => {
    const svc = new DialogContextService(mockClient(), 'assistant');
    const prompt = await svc.buildSystemPrompt(14128108, 'arcana-prod IP?');
    expect(prompt).toContain('<past_conversation_memories>');
    expect(prompt).toContain('</past_conversation_memories>');
    expect(prompt).toContain('arcana-prod IP 65.108.236.39');
    expect(prompt).toContain('Vault primary on arcana-db:8200');
    expect(prompt).toContain('91%');
    expect(prompt).toContain('55%');
  });

  it('passes server-derived namespace and override options to recall', async () => {
    const client = mockClient();
    const svc = new DialogContextService(client, 'assistant');
    await svc.buildSystemPrompt(42, 'q', { maxHits: 3, minScore: 0.2 });
    expect(client.recallLtm).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'q',
        namespace: 'assistant:user:42',
        limit: 3,
        min_score: 0.2,
      }),
    );
  });

  it('returns just systemPrefix when recall is empty (no memories block)', async () => {
    const client = mockClient({ recallLtm: vi.fn(async () => RECALL_EMPTY) });
    const svc = new DialogContextService(client, 'assistant');
    const prompt = await svc.buildSystemPrompt(1, 'x', { systemPrefix: 'You are an assistant.' });
    expect(prompt).toBe('You are an assistant.');
    expect(prompt).not.toContain('past_conversation_memories');
  });

  it('returns empty string when no prefix and recall is empty', async () => {
    const client = mockClient({ recallLtm: vi.fn(async () => RECALL_EMPTY) });
    const svc = new DialogContextService(client, 'assistant');
    expect(await svc.buildSystemPrompt(1, 'x')).toBe('');
  });

  it('soft-fails (no throw) and warns when circuit is open', async () => {
    const client = mockClient({ isCircuitOpen: () => true });
    const svc = new DialogContextService(client, 'assistant');
    const prompt = await svc.buildSystemPrompt(1, 'x', { systemPrefix: 'P' });
    expect(prompt).toContain('временно недоступен');
    expect(client.recallLtm).not.toHaveBeenCalled();
    expect(prompt.startsWith('P')).toBe(true);
  });

  it('soft-fails when recall throws', async () => {
    const client = mockClient({
      recallLtm: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const svc = new DialogContextService(client, 'assistant');
    const prompt = await svc.buildSystemPrompt(1, 'x');
    expect(prompt).toContain('временно недоступен');
  });

  it('uses default maxHits=5 and minScore=0.1', async () => {
    const client = mockClient();
    const svc = new DialogContextService(client, 'assistant');
    await svc.buildSystemPrompt(1, 'x');
    expect(client.recallLtm).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, min_score: 0.1 }),
    );
  });

  it('respects custom ltmNamespacePrefix', async () => {
    const client = mockClient();
    const svc = new DialogContextService(client, 'assistant-staging');
    await svc.buildSystemPrompt(7, 'q');
    expect(client.recallLtm).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'assistant-staging:user:7' }),
    );
  });

  it('places prefix before memories block', async () => {
    const svc = new DialogContextService(mockClient(), 'assistant');
    const prompt = await svc.buildSystemPrompt(1, 'q', { systemPrefix: 'PREFIX_X' });
    const prefixIdx = prompt.indexOf('PREFIX_X');
    const memIdx = prompt.indexOf('<past_conversation_memories>');
    expect(prefixIdx).toBeGreaterThanOrEqual(0);
    expect(memIdx).toBeGreaterThan(prefixIdx);
  });
});
