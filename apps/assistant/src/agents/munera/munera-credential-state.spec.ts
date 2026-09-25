/**
 * A2-313 — `/health` must not call a dead key `ok`.
 *
 * Bodies below are what the REAL Muneral wrote, not what this client expects:
 *   - 401: `GET https://api.muneral.com/api/v1/tasks/digest` with the production
 *     placeholder, 2026-09-25T07:04:25Z (A2-294e §5):
 *     `{"message":"Unauthorized","statusCode":401}`.
 *   - 403: the same route with the assistant's real agent key, 2026-09-25T08:13Z
 *     (A2-313, `DIGEST_GRANT_REQUIRED`, pinned in `muneral-responses.ts`).
 */
import { describe, expect, it, vi } from 'vitest';

import { DIGEST_GRANT_REQUIRED_ENVELOPE } from '../../proactive/__fixtures__/muneral-responses.js';

import { MuneraAgentService } from './munera-agent.service.js';
import { MuneraClient, type IMuneraClient } from './munera.client.js';

const LIVE_401_BODY = { message: 'Unauthorized', statusCode: 401 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientAnswering(...responses: Response[]): MuneraClient {
  const fetchImpl = vi.fn();
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r);
  return new MuneraClient({
    baseUrl: 'https://api.muneral.com/api/v1',
    apiToken: 'mun_sk_test',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe('MuneraClient.credentialState (A2-313)', () => {
  it('is unverified before Muneral has answered anything', () => {
    expect(clientAnswering().credentialState()).toBe('unverified');
  });

  it('is rejected after the live 401 — and the breaker stays closed, which is the trap', async () => {
    const client = clientAnswering(jsonResponse(401, LIVE_401_BODY));
    const result = await client.queryWorkspaceDigest({ status: 'done' });
    expect(result.kind).toBe('unavailable');
    expect(client.isCircuitOpen()).toBe(false);
    expect(client.credentialState()).toBe('rejected');
  });

  it('is accepted after the live DIGEST_GRANT_REQUIRED 403: authenticated, not authorised', async () => {
    const client = clientAnswering(jsonResponse(403, DIGEST_GRANT_REQUIRED_ENVELOPE));
    await client.queryWorkspaceDigest({ status: 'done' });
    expect(client.credentialState()).toBe('accepted');
  });

  it('recovers to accepted when a later call authenticates', async () => {
    const client = clientAnswering(
      jsonResponse(401, LIVE_401_BODY),
      jsonResponse(200, { items: [], total: 0, limit: 200, offset: 0 }),
    );
    await client.queryWorkspaceDigest({ status: 'done' });
    await client.queryWorkspaceDigest({ status: 'done' });
    expect(client.credentialState()).toBe('accepted');
  });
});

describe('MuneraAgentService.healthSnapshot (A2-313)', () => {
  it('reports degraded, not ok, once Muneral has rejected the key', async () => {
    const client = clientAnswering(jsonResponse(401, LIVE_401_BODY));
    const agent = new MuneraAgentService(client);
    expect(agent.healthSnapshot().state).toBe('ok');
    await client.queryWorkspaceDigest({ status: 'done' });
    expect(agent.healthSnapshot()).toMatchObject({
      state: 'degraded',
      circuit: 'closed',
      reason: 'munera_credential_rejected',
    });
  });

  it('treats a client that does not report credentials as before (no false degraded)', () => {
    const client = { isCircuitOpen: () => false } as unknown as IMuneraClient;
    expect(new MuneraAgentService(client).healthSnapshot().state).toBe('ok');
  });
});
