import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { ScrutatorClient, ScrutatorClientError } from './scrutator.client.js';
import type { ScrutatorLogger } from './scrutator.client.js';

const BASE_URL = 'http://scrutator.test.local';

interface ServerCallLog {
  authorization: string | null;
  count: { health: number; search: number; ingest: number; recall: number };
}

function makeServer(): { server: ReturnType<typeof setupServer>; calls: ServerCallLog } {
  const calls: ServerCallLog = {
    authorization: null,
    count: { health: 0, search: 0, ingest: 0, recall: 0 },
  };
  const server = setupServer(
    http.get(`${BASE_URL}/health`, ({ request }) => {
      calls.count.health += 1;
      calls.authorization = request.headers.get('authorization');
      return HttpResponse.json({ status: 'ok', service: 'Scrutator', version: '0.3.0' });
    }),
    http.post(`${BASE_URL}/v1/search`, async ({ request }) => {
      calls.count.search += 1;
      calls.authorization = request.headers.get('authorization');
      const body = (await request.json()) as { query: string; limit?: number };
      return HttpResponse.json({
        results: [
          {
            chunk_id: 'fixture-chunk-1',
            content: `match for ${body.query}`,
            source_path: 'wiki/page.md',
            source_type: 'markdown',
            chunk_index: 0,
            score: 0.42,
            namespace: 'arcanada',
            project: null,
            heading_hierarchy: ['# Title', '## Sub'],
            metadata: { language: 'en' },
          },
        ],
        total: 1,
        query: body.query,
        search_time_ms: 12.3,
      });
    }),
    http.post(`${BASE_URL}/v1/ltm/ingest`, async () => {
      calls.count.ingest += 1;
      return HttpResponse.json({});
    }),
    http.post(`${BASE_URL}/v1/ltm/recall`, async ({ request }) => {
      calls.count.recall += 1;
      const body = (await request.json()) as { query: string; namespace?: string };
      return HttpResponse.json({
        results: [
          {
            chunk_id: 'recall-chunk-1',
            content: 'remembered fact',
            source_path: 'fixture://x',
            score: 0.81,
            namespace: body.namespace ?? 'global',
            project: null,
            entities: [],
            relations: [],
          },
        ],
        total: 1,
        query: body.query,
        search_time_ms: 88.0,
      });
    }),
  );
  return { server, calls };
}

const { server, calls } = makeServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  calls.authorization = null;
  calls.count.health = 0;
  calls.count.search = 0;
  calls.count.ingest = 0;
  calls.count.recall = 0;
});
afterAll(() => server.close());

function makeClient(opts: { logger?: ScrutatorLogger; baseUrl?: string } = {}): ScrutatorClient {
  return new ScrutatorClient({
    baseUrl: opts.baseUrl ?? BASE_URL,
    logger: opts.logger,
    fetchImpl: globalThis.fetch.bind(globalThis),
    timeoutMs: 1_000,
    healthTimeoutMs: 1_000,
    retry: { maxAttempts: 1, baseDelayMs: 10 },
  });
}

describe('ScrutatorClient', () => {
  describe('ping()', () => {
    it('returns ok=true + version on /health 200', async () => {
      const client = makeClient();
      const res = await client.ping();
      expect(res.ok).toBe(true);
      expect(res.version).toBe('0.3.0');
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
      expect(calls.count.health).toBe(1);
    });

    it('returns ok=false on 5xx', async () => {
      server.use(http.get(`${BASE_URL}/health`, () => HttpResponse.text('boom', { status: 500 })));
      const client = makeClient();
      const res = await client.ping();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/HTTP 500/);
    });

    it('does NOT send Authorization header (Tailscale-only, no bearer auth)', async () => {
      const client = makeClient();
      await client.ping();
      expect(calls.authorization).toBeNull();
    });
  });

  describe('searchWiki()', () => {
    it('returns parsed SearchResult on happy path', async () => {
      const client = makeClient();
      const res = await client.searchWiki({ query: 'Datarim', limit: 3 });
      expect(res.total).toBe(1);
      expect(res.results[0]?.chunk_id).toBe('fixture-chunk-1');
      expect(res.results[0]?.heading_hierarchy).toEqual(['# Title', '## Sub']);
    });

    it('throws ScrutatorClientError on invalid input (Zod)', async () => {
      const client = makeClient();
      await expect(client.searchWiki({ query: '' })).rejects.toBeInstanceOf(ScrutatorClientError);
    });

    it('throws on response shape mismatch', async () => {
      server.use(
        http.post(`${BASE_URL}/v1/search`, () => HttpResponse.json({ wrong_shape: true })),
      );
      const client = makeClient();
      await expect(client.searchWiki({ query: 'x' })).rejects.toBeInstanceOf(ScrutatorClientError);
    });
  });

  describe('ingestLtm()', () => {
    it('returns ok=true async=false on plain 200', async () => {
      const client = makeClient();
      const res = await client.ingestLtm({
        content: 'fact',
        source_path: 'fixture://a',
        namespace: 'assistant:user:42',
      });
      expect(res.ok).toBe(true);
      expect(res.async).toBe(false);
    });

    it('returns ok=true async=true + warning on 200 {detail: "Ingest failed"}', async () => {
      server.use(
        http.post(`${BASE_URL}/v1/ltm/ingest`, () =>
          HttpResponse.json({ detail: 'Ingest failed' }),
        ),
      );
      const warn = vi.fn();
      const client = makeClient({ logger: { info: vi.fn(), warn, error: vi.fn() } });
      const res = await client.ingestLtm({
        content: 'fact',
        source_path: 'fixture://b',
        namespace: 'assistant:user:42',
      });
      expect(res.ok).toBe(true);
      expect(res.async).toBe(true);
      expect(res.warning).toBe('scrutator-soft-fail');
      expect(warn).toHaveBeenCalledOnce();
    });

    it('throws on Zod-invalid input (missing source_path)', async () => {
      const client = makeClient();
      await expect(
        // @ts-expect-error — intentionally violating the schema
        client.ingestLtm({ content: 'x' }),
      ).rejects.toBeInstanceOf(ScrutatorClientError);
    });
  });

  describe('recallLtm()', () => {
    it('returns parsed RecallResult on happy path', async () => {
      const client = makeClient();
      const res = await client.recallLtm({
        query: 'q',
        namespace: 'assistant:user:42',
        limit: 3,
      });
      expect(res.total).toBe(1);
      expect(res.results[0]?.namespace).toBe('assistant:user:42');
      expect(res.results[0]?.entities).toEqual([]);
    });
  });

  describe('circuit breaker', () => {
    it('errorFilter: 401 propagates as ClientError but does NOT trip breaker (4xx)', async () => {
      server.use(
        http.post(`${BASE_URL}/v1/search`, () => HttpResponse.text('unauth', { status: 401 })),
      );
      const client = makeClient();
      // 5 consecutive 401s — would trip a breaker without errorFilter.
      for (let i = 0; i < 5; i += 1) {
        await expect(client.searchWiki({ query: 'x' })).rejects.toBeInstanceOf(
          ScrutatorClientError,
        );
      }
      expect(client.isCircuitOpen()).toBe(false);
    });

    it('5xx counts toward CB; opens after volumeThreshold consecutive failures', async () => {
      server.use(
        http.post(`${BASE_URL}/v1/search`, () => HttpResponse.text('boom', { status: 500 })),
      );
      const client = makeClient();
      for (let i = 0; i < 5; i += 1) {
        await expect(client.searchWiki({ query: 'x' })).rejects.toBeInstanceOf(
          ScrutatorClientError,
        );
      }
      expect(client.isCircuitOpen()).toBe(true);
    });
  });

  describe('logger redaction surface', () => {
    it('warn log on non-2xx does not include request body or token-shape strings', async () => {
      server.use(
        http.post(`${BASE_URL}/v1/search`, () => HttpResponse.text('boom', { status: 500 })),
      );
      const warn = vi.fn();
      const client = makeClient({ logger: { info: vi.fn(), warn, error: vi.fn() } });
      await expect(client.searchWiki({ query: 'x' })).rejects.toBeInstanceOf(ScrutatorClientError);
      const calls = warn.mock.calls;
      const serialized = calls.map((c) => JSON.stringify(c)).join('\n');
      expect(serialized).not.toMatch(/Bearer\s+/);
      expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    });
  });
});
