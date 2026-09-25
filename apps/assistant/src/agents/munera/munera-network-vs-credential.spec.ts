/**
 * A2-360 — "the key is missing" and "Muneral is silent" are different faults.
 *
 * A2-313 made a missing or placeholder key a refusal to BOOT. That is only
 * safe if nothing about Muneral's reachability can reach the same refusal:
 * a boot that fails because someone else's network is down turns their outage
 * into ours. And at runtime `/health` must name which of the two it is.
 *
 * These run the REAL `fetch` against REAL loopback sockets, not a mocked fetch:
 *   - a port that was bound and closed → ECONNREFUSED, what a down Muneral is;
 *   - a server answering `302 Location: /en/…` + HTML, the shape
 *     `https://muneral.com/api/v1/tasks/digest` answered on 2026-09-25
 *     (`302 redirect=https://muneral.com/en/api/v1/tasks/digest`, A2-360
 *     `out-hosts.txt`).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MuneraAgentService } from './munera-agent.service.js';
import { MuneraClient } from './munera.client.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function client(baseUrl: string): MuneraClient {
  return new MuneraClient({
    baseUrl,
    apiToken: 'mun_sk_test',
    timeoutMs: 2_000,
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    circuit: {
      volumeThreshold: 2,
      errorThresholdPercentage: 50,
      rollingCountTimeout: 30_000,
      resetTimeout: 60_000,
    },
  });
}

let closedPort = 0;
let site: Server;
let sitePort = 0;

beforeAll(async () => {
  const probe = createServer();
  closedPort = await listen(probe);
  await close(probe);
  site = createServer((req, res) => {
    if (req.url?.startsWith('/en/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Muneral</body></html>');
      return;
    }
    res.writeHead(302, { location: `/en${req.url ?? '/'}` });
    res.end();
  });
  sitePort = await listen(site);
});

afterAll(async () => {
  await close(site);
});

describe('Muneral unreachable, key present (A2-360)', () => {
  it('does not read a refused connection as a verdict on the key', async () => {
    const c = client(`http://127.0.0.1:${closedPort}/api/v1`);
    const result = await c.queryWorkspaceDigest({ status: 'done' });
    expect(result.kind).toBe('unavailable');
    expect(c.credentialState()).toBe('unverified');
  });

  it('reports the outage as unavailable, never as a rejected credential', async () => {
    const c = client(`http://127.0.0.1:${closedPort}/api/v1`);
    const agent = new MuneraAgentService(c);
    for (let i = 0; i < 3; i++) await c.queryWorkspaceDigest({ status: 'done' });
    expect(c.isCircuitOpen()).toBe(true);
    const snap = agent.healthSnapshot();
    expect(snap.state).toBe('unavailable');
    expect(snap).not.toMatchObject({ reason: 'munera_credential_rejected' });
  });
});

describe('MUNERA_BASE_URL on a host that redirects (A2-360)', () => {
  it('does not follow the site redirect into a 2xx that reads as an accepted key', async () => {
    const c = client(`http://127.0.0.1:${sitePort}/api/v1`);
    const result = await c.queryWorkspaceDigest({ status: 'done' });
    expect(result.kind).toBe('unavailable');
    expect(c.credentialState()).not.toBe('accepted');
  });
});
