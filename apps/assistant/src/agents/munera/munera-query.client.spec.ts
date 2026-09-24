import { describe, expect, it, vi } from 'vitest';

import { AGENT_KEY_FORBIDDEN_ENVELOPE } from '../../proactive/__fixtures__/muneral-responses.js';

import { MuneraClient, normaliseMuneraBaseUrl } from './munera.client.js';
import { UnconfiguredMuneraClient } from './munera-unconfigured.client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MuneraClient.queryTasks (A2-281)', () => {
  it('calls GET /api/v1/tasks with the filters and the required User-Agent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { items: [], total: 0, limit: 200, offset: 0 }),
    );
    const client = new MuneraClient({
      baseUrl: 'https://api.muneral.com/api/v1',
      apiToken: 'mun_sk_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.queryTasks({
      status: 'done',
      updatedSince: '2026-09-23T21:00:00.000Z',
      limit: 200,
    });

    expect(result.kind).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0]!;
    // Not `…/api/v1/api/v1/tasks`: the canonical base URL carries the prefix.
    expect(url).toBe(
      'https://api.muneral.com/api/v1/tasks?status=done&updatedSince=2026-09-23T21%3A00%3A00.000Z&limit=200',
    );
    expect((init.headers as Record<string, string>)['user-agent']).toBe('aup-orchestrator/1.0');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer mun_sk_test');
  });

  it('reports the live 403 envelope as unavailable with its status, not as an empty page', async () => {
    const client = new MuneraClient({
      baseUrl: 'https://api.muneral.com',
      apiToken: 'mun_sk_test',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(jsonResponse(403, AGENT_KEY_FORBIDDEN_ENVELOPE)) as unknown as typeof fetch,
    });
    const result = await client.queryTasks({ status: 'in_progress' });
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.statusCode).toBe(403);
    expect(result.errorCode).toBe('forbidden');
  });

  it('refuses to read a page whose shape is not the documented envelope', async () => {
    const client = new MuneraClient({
      baseUrl: 'https://api.muneral.com',
      apiToken: 'mun_sk_test',
      // A bare array is what `GET /tasks/project/:id` answers — a consumer that
      // accepted it here would silently lose `total`.
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, [])) as unknown as typeof fetch,
    });
    const result = await client.queryTasks({});
    expect(result.kind).toBe('unavailable');
  });

  it('accepts a page containing an archived row', async () => {
    const client = new MuneraClient({
      baseUrl: 'https://api.muneral.com',
      apiToken: 'mun_sk_test',
      fetchImpl: vi.fn().mockResolvedValue(
        jsonResponse(200, {
          items: [
            {
              id: '0f1c4d8a-1111-4aaa-9bbb-000000000009',
              projectId: '08a50f9a-a735-4605-91ce-ce4a41193fbb',
              title: 'A2-240',
              status: 'archived',
              priority: 'low',
              createdAt: '2026-09-01T09:00:00.000Z',
              updatedAt: '2026-09-24T09:00:00.000Z',
            },
          ],
          total: 1,
          limit: 200,
          offset: 0,
        }),
      ) as unknown as typeof fetch,
    });
    const result = await client.queryTasks({ status: 'archived' });
    expect(result.kind).toBe('ok');
  });
});

describe('normaliseMuneraBaseUrl', () => {
  it('accepts both the canonical API URL and a bare origin', () => {
    expect(normaliseMuneraBaseUrl('https://api.muneral.com/api/v1')).toBe('https://api.muneral.com');
    expect(normaliseMuneraBaseUrl('https://api.muneral.com/api/v1/')).toBe('https://api.muneral.com');
    expect(normaliseMuneraBaseUrl('http://localhost:3500')).toBe('http://localhost:3500');
  });
});

describe('UnconfiguredMuneraClient', () => {
  it('answers unavailable without touching the network', async () => {
    const client = new UnconfiguredMuneraClient();
    expect(client.isCircuitOpen()).toBe(true);
    await expect(client.queryTasks()).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'munera_credential_not_configured',
    });
  });
});
