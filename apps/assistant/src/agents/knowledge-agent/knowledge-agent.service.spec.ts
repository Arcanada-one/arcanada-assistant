import { describe, it, expect, vi } from 'vitest';
import type {
  IScrutatorClient,
  IngestResult,
  RecallResult,
  SearchResult,
} from '@arcanada/core';

import { KnowledgeAgentService, type KnowledgeAgentResult } from './knowledge-agent.service.js';

const SEARCH_RESULT: SearchResult = {
  results: [
    {
      chunk_id: 'c1',
      content: 'Datarim is a workflow framework',
      source_path: 'wiki/Datarim.md',
      source_type: 'markdown',
      chunk_index: 0,
      score: 0.42,
      namespace: 'arcanada',
      project: null,
      heading_hierarchy: ['# Datarim', '## Overview'],
      metadata: {},
    },
  ],
  total: 1,
  query: 'Datarim',
  search_time_ms: 168.4,
};

const RECALL_RESULT: RecallResult = {
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
  ],
  total: 1,
  query: 'IP',
  search_time_ms: 88.7,
};

function mockClient(overrides: Partial<IScrutatorClient> = {}): IScrutatorClient {
  return {
    ping: vi.fn(async () => ({ ok: true, latencyMs: 5, version: '0.3.0' })),
    searchWiki: vi.fn(async () => SEARCH_RESULT),
    ingestLtm: vi.fn(async (): Promise<IngestResult> => ({ ok: true, async: false })),
    recallLtm: vi.fn(async () => RECALL_RESULT),
    isCircuitOpen: vi.fn(() => false),
    ...overrides,
  };
}

describe('KnowledgeAgentService', () => {
  it('declares /wiki, /remember, /recall intents', () => {
    const agent = new KnowledgeAgentService(mockClient(), 'assistant');
    expect(agent.name).toBe('knowledge');
    expect([...agent.intents]).toEqual(['/wiki', '/remember', '/recall']);
  });

  it('returns unavailable when circuit breaker is open', async () => {
    const client = mockClient({ isCircuitOpen: () => true });
    const agent = new KnowledgeAgentService(client, 'assistant');
    const result = (await agent.execute('/wiki', { query: 'x' })) as KnowledgeAgentResult;
    expect(result.kind).toBe('unavailable');
    expect(client.searchWiki).not.toHaveBeenCalled();
  });

  it('throws on unknown intent', async () => {
    const agent = new KnowledgeAgentService(mockClient(), 'assistant');
    await expect(agent.execute('/unknown')).rejects.toThrow(/does not handle/);
  });

  // ── /wiki ────────────────────────────────────────────────────────────────
  describe('/wiki', () => {
    it('returns wiki_hits with rendered hits + searchTimeMs', async () => {
      const agent = new KnowledgeAgentService(mockClient(), 'assistant');
      const r = (await agent.execute('/wiki', { query: 'Datarim' })) as KnowledgeAgentResult;
      expect(r.kind).toBe('wiki_hits');
      if (r.kind === 'wiki_hits') {
        expect(r.hits).toHaveLength(1);
        expect(r.hits[0]).toEqual({
          chunkId: 'c1',
          content: 'Datarim is a workflow framework',
          sourcePath: 'wiki/Datarim.md',
          score: 0.42,
          heading: '## Overview',
        });
        expect(r.searchTimeMs).toBe(168.4);
      }
    });

    it('passes namespace=arcanada and limit=5 to client', async () => {
      const client = mockClient();
      const agent = new KnowledgeAgentService(client, 'assistant');
      await agent.execute('/wiki', { query: 'test' });
      expect(client.searchWiki).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test',
          namespace: 'arcanada',
          limit: 5,
          include_content: true,
        }),
      );
    });

    it('returns text "ничего не найдено" on empty results', async () => {
      const client = mockClient({
        searchWiki: vi.fn(async () => ({ ...SEARCH_RESULT, results: [], total: 0 })),
      });
      const agent = new KnowledgeAgentService(client, 'assistant');
      const r = (await agent.execute('/wiki', { query: 'nope' })) as KnowledgeAgentResult;
      expect(r.kind).toBe('text');
      if (r.kind === 'text') expect(r.text).toMatch(/ничего не найдено/i);
    });

    it('returns text prompt on empty query', async () => {
      const client = mockClient();
      const agent = new KnowledgeAgentService(client, 'assistant');
      const r = (await agent.execute('/wiki', { query: '   ' })) as KnowledgeAgentResult;
      expect(r.kind).toBe('text');
      expect(client.searchWiki).not.toHaveBeenCalled();
    });

    it('wraps client throw in unavailable result', async () => {
      const client = mockClient({
        searchWiki: vi.fn(async () => {
          throw new Error('boom');
        }),
      });
      const agent = new KnowledgeAgentService(client, 'assistant');
      const r = (await agent.execute('/wiki', { query: 'q' })) as KnowledgeAgentResult;
      expect(r.kind).toBe('unavailable');
      if (r.kind === 'unavailable') {
        expect(r.reason).toBe('scrutator_error');
        expect(r.error).toBe('boom');
      }
    });
  });

  // ── /remember ────────────────────────────────────────────────────────────
  describe('/remember', () => {
    it('returns "remembered" with server-derived namespace', async () => {
      const client = mockClient();
      const agent = new KnowledgeAgentService(client, 'assistant');
      const r = (await agent.execute('/remember', {
        text: 'arcana-prod IP 65.108.236.39',
        userId: 14128108,
      })) as KnowledgeAgentResult;
      expect(r.kind).toBe('remembered');
      if (r.kind === 'remembered') {
        expect(r.namespace).toBe('assistant:user:14128108');
        expect(r.async).toBe(false);
      }
      expect(client.ingestLtm).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'arcana-prod IP 65.108.236.39',
          source_path: 'telegram://user-memory/14128108',
          namespace: 'assistant:user:14128108',
        }),
      );
    });

    it('flags async=true when client returns soft-fail (async ingest)', async () => {
      const client = mockClient({
        ingestLtm: vi.fn(async (): Promise<IngestResult> => ({ ok: true, async: true, warning: 'scrutator-soft-fail' })),
      });
      const agent = new KnowledgeAgentService(client, 'assistant');
      const r = (await agent.execute('/remember', { text: 'x', userId: 1 })) as KnowledgeAgentResult;
      expect(r.kind).toBe('remembered');
      if (r.kind === 'remembered') expect(r.async).toBe(true);
    });

    it('returns unavailable when ingest fails (ok=false)', async () => {
      const client = mockClient({
        ingestLtm: vi.fn(async (): Promise<IngestResult> => ({ ok: false, async: false })),
      });
      const agent = new KnowledgeAgentService(client, 'assistant');
      const r = (await agent.execute('/remember', { text: 'x', userId: 1 })) as KnowledgeAgentResult;
      expect(r.kind).toBe('unavailable');
    });

    it('returns text prompt on empty text', async () => {
      const client = mockClient();
      const agent = new KnowledgeAgentService(client, 'assistant');
      const r = (await agent.execute('/remember', { text: '   ', userId: 1 })) as KnowledgeAgentResult;
      expect(r.kind).toBe('text');
      expect(client.ingestLtm).not.toHaveBeenCalled();
    });

    it('returns unavailable on missing userId', async () => {
      const agent = new KnowledgeAgentService(mockClient(), 'assistant');
      const r = (await agent.execute('/remember', { text: 'x', userId: NaN })) as KnowledgeAgentResult;
      expect(r.kind).toBe('unavailable');
      if (r.kind === 'unavailable') expect(r.reason).toBe('missing_user_id');
    });

    it('wraps client throw in unavailable', async () => {
      const client = mockClient({
        ingestLtm: vi.fn(async () => {
          throw new Error('ingest-broken');
        }),
      });
      const agent = new KnowledgeAgentService(client, 'assistant');
      const r = (await agent.execute('/remember', { text: 't', userId: 1 })) as KnowledgeAgentResult;
      expect(r.kind).toBe('unavailable');
      if (r.kind === 'unavailable') expect(r.reason).toBe('scrutator_error');
    });
  });

  // ── /recall ──────────────────────────────────────────────────────────────
  describe('/recall', () => {
    it('returns recall_hits with server-derived namespace', async () => {
      const client = mockClient();
      const agent = new KnowledgeAgentService(client, 'assistant');
      const r = (await agent.execute('/recall', {
        query: 'IP',
        userId: 14128108,
      })) as KnowledgeAgentResult;
      expect(r.kind).toBe('recall_hits');
      if (r.kind === 'recall_hits') {
        expect(r.hits).toHaveLength(1);
        expect(r.hits[0]).toEqual({
          chunkId: 'm1',
          content: 'arcana-prod IP 65.108.236.39',
          score: 0.91,
          sourcePath: 'telegram://user-memory/14128108',
        });
      }
      expect(client.recallLtm).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'IP',
          namespace: 'assistant:user:14128108',
          limit: 5,
        }),
      );
    });

    it('returns text on empty results', async () => {
      const client = mockClient({
        recallLtm: vi.fn(async () => ({ ...RECALL_RESULT, results: [], total: 0 })),
      });
      const agent = new KnowledgeAgentService(client, 'assistant');
      const r = (await agent.execute('/recall', { query: 'q', userId: 1 })) as KnowledgeAgentResult;
      expect(r.kind).toBe('text');
      if (r.kind === 'text') expect(r.text).toMatch(/ничего не вспомнил/i);
    });

    it('returns unavailable on missing userId', async () => {
      const agent = new KnowledgeAgentService(mockClient(), 'assistant');
      const r = (await agent.execute('/recall', { query: 'q', userId: NaN })) as KnowledgeAgentResult;
      expect(r.kind).toBe('unavailable');
    });

    it('wraps client throw in unavailable', async () => {
      const client = mockClient({
        recallLtm: vi.fn(async () => {
          throw new Error('recall-broken');
        }),
      });
      const agent = new KnowledgeAgentService(client, 'assistant');
      const r = (await agent.execute('/recall', { query: 'q', userId: 1 })) as KnowledgeAgentResult;
      expect(r.kind).toBe('unavailable');
    });

    it('uses custom ltmNamespacePrefix', async () => {
      const client = mockClient();
      const agent = new KnowledgeAgentService(client, 'assistant-staging');
      await agent.execute('/recall', { query: 'q', userId: 42 });
      expect(client.recallLtm).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'assistant-staging:user:42' }),
      );
    });
  });
});
