import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_KEY_FORBIDDEN_ENVELOPE,
  DIGEST_GRANT_EXPIRED_ENVELOPE,
  DIGEST_GRANT_REQUIRED_ENVELOPE,
} from '../../proactive/__fixtures__/muneral-responses.js';

import { MuneraClient, normaliseMuneraBaseUrl } from './munera.client.js';
import { UnconfiguredMuneraClient } from './munera-unconfigured.client.js';
import { DIGEST_GRANT_EXPIRED, DIGEST_GRANT_REQUIRED } from './munera.schemas.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MuneraClient.queryWorkspaceDigest (A2-281, A2-294)', () => {
  it('calls GET /api/v1/tasks/digest with the filters and the required User-Agent', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { items: [], total: 0, limit: 200, offset: 0 }));
    const client = new MuneraClient({
      baseUrl: 'https://api.muneral.com/api/v1',
      apiToken: 'mun_sk_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.queryWorkspaceDigest({
      status: 'done',
      updatedSince: '2026-09-23T21:00:00.000Z',
      limit: 200,
    });

    expect(result.kind).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0]!;
    // Not `…/api/v1/api/v1/tasks/digest`: the canonical base URL carries the
    // prefix. A2-294: `/digest`, not the unmarked `GET /tasks` that answers 403.
    expect(url).toBe(
      'https://api.muneral.com/api/v1/tasks/digest?status=done&updatedSince=2026-09-23T21%3A00%3A00.000Z&limit=200',
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
        .mockResolvedValue(
          jsonResponse(403, AGENT_KEY_FORBIDDEN_ENVELOPE),
        ) as unknown as typeof fetch,
    });
    const result = await client.queryWorkspaceDigest({ status: 'in_progress' });
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
    const result = await client.queryWorkspaceDigest({});
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
    const result = await client.queryWorkspaceDigest({ status: 'archived' });
    expect(result.kind).toBe('ok');
  });
});

describe('normaliseMuneraBaseUrl', () => {
  it('accepts both the canonical API URL and a bare origin', () => {
    expect(normaliseMuneraBaseUrl('https://api.muneral.com/api/v1')).toBe(
      'https://api.muneral.com',
    );
    expect(normaliseMuneraBaseUrl('https://api.muneral.com/api/v1/')).toBe(
      'https://api.muneral.com',
    );
    expect(normaliseMuneraBaseUrl('http://localhost:3500')).toBe('http://localhost:3500');
  });
});

describe('UnconfiguredMuneraClient', () => {
  it('answers unavailable without touching the network', async () => {
    const client = new UnconfiguredMuneraClient();
    expect(client.isCircuitOpen()).toBe(true);
    await expect(client.queryWorkspaceDigest()).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'munera_credential_not_configured',
    });
  });

  // A2-294 — the two grant refusals. Both bodies are objects with a `code` and
  // NO `error`/`statusCode`, so before this change they matched none of the
  // client's envelope schemas and arrived as an unclassified `HTTP 403`.
  it('classifies DIGEST_GRANT_REQUIRED from the body Muneral actually sends', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, DIGEST_GRANT_REQUIRED_ENVELOPE));
    const client = new MuneraClient({
      baseUrl: 'https://api.muneral.com/api/v1',
      apiToken: 'mun_sk_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { maxAttempts: 0, baseDelayMs: 0 },
    });

    const result = await client.queryWorkspaceDigest({ status: 'done' });

    expect(result).toMatchObject({
      kind: 'unavailable',
      statusCode: 403,
      errorCode: DIGEST_GRANT_REQUIRED,
    });
    // Never the raw-body fallback: that string is what the operator used to get.
    expect(JSON.stringify(result)).not.toContain('HTTP 403:');
  });

  it('classifies GRANT_EXPIRED and carries `until` and `decision` through', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, DIGEST_GRANT_EXPIRED_ENVELOPE));
    const client = new MuneraClient({
      baseUrl: 'https://api.muneral.com/api/v1',
      apiToken: 'mun_sk_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { maxAttempts: 0, baseDelayMs: 0 },
    });

    const result = await client.queryWorkspaceDigest({ status: 'done' });

    expect(result).toMatchObject({
      kind: 'unavailable',
      statusCode: 403,
      errorCode: DIGEST_GRANT_EXPIRED,
      grantUntil: '2026-10-25T00:00:00Z',
      grantDecision: 'DEC-AUP-0049',
    });
  });

  it('keeps the two refusals distinct — an expired grant is not a missing one', async () => {
    const mk = (body: unknown) =>
      new MuneraClient({
        baseUrl: 'https://api.muneral.com/api/v1',
        apiToken: 'mun_sk_test',
        fetchImpl: vi.fn().mockResolvedValue(jsonResponse(403, body)) as unknown as typeof fetch,
        retry: { maxAttempts: 0, baseDelayMs: 0 },
      });
    const required = await mk(DIGEST_GRANT_REQUIRED_ENVELOPE).queryWorkspaceDigest({});
    const expired = await mk(DIGEST_GRANT_EXPIRED_ENVELOPE).queryWorkspaceDigest({});
    expect(required).toHaveProperty('errorCode', DIGEST_GRANT_REQUIRED);
    expect(expired).toHaveProperty('errorCode', DIGEST_GRANT_EXPIRED);
    expect((required as { errorCode?: string }).errorCode).not.toBe(
      (expired as { errorCode?: string }).errorCode,
    );
  });

  it('parses the four additive keys of a 200 digest page, including `grant`', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
        counted: "every task of the key's own workspace matching the filters, before paging",
        generatedAt: '2026-09-25T06:00:00.000Z',
        auditEventId: '11111111-2222-3333-4444-555555555555',
        grant: {
          decision: 'DEC-AUP-0049',
          until: '2026-10-25T00:00:00.000Z',
          renewalDueAt: '2026-10-18T00:00:00.000Z',
        },
      }),
    );
    const client = new MuneraClient({
      baseUrl: 'https://api.muneral.com/api/v1',
      apiToken: 'mun_sk_test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.queryWorkspaceDigest({});

    expect(result).toMatchObject({
      kind: 'ok',
      page: {
        total: 0,
        auditEventId: '11111111-2222-3333-4444-555555555555',
        grant: { decision: 'DEC-AUP-0049', renewalDueAt: '2026-10-18T00:00:00.000Z' },
      },
    });
  });
});
