/**
 * A2-374 — "the key is missing" and "Muneral is silent" give different codes
 * and different exit statuses, measured against REAL sockets with the REAL
 * `fetch`. Response bodies are the ones Muneral production returned
 * (`__fixtures__/muneral-responses.ts`, A2-294 / A2-313 receipts).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EX_CONFIG, EX_NOPERM, EX_UNAVAILABLE } from './config/munera-boot-gate.js';
import { runMuneraCheck } from './munera-check.js';
import {
  DIGEST_GRANT_REQUIRED_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from './proactive/__fixtures__/muneral-responses.js';

const KEY = 'mun_sk_example_value_not_a_real_key';
const readFile = (): string => `${KEY}\n`;
const WITH_KEY = { MUNERAL_AGENT_KEY_FILE: '/run/secrets/muneral-agent-key' };

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

let closedPort = 0;
let api: Server;
let apiPort = 0;
const seen: { path?: string; auth?: string; ua?: string }[] = [];

beforeAll(async () => {
  const s = createServer();
  closedPort = await listen(s);
  await close(s); // bound, then closed: ECONNREFUSED, what a down Muneral is
  api = createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization, ua: req.headers['user-agent'] });
    const mode = req.headers.authorization === `Bearer ${KEY}` ? 'grant' : 'unauth';
    if (req.url?.startsWith('/site/')) {
      res.writeHead(302, { Location: '/en/api/v1/tasks/digest', 'Content-Type': 'text/html' });
      res.end('<html></html>');
      return;
    }
    // The real digest refusal carries no statusCode in its body; the 403 is the HTTP status.
    const [status, body] =
      mode === 'grant' ? [403, DIGEST_GRANT_REQUIRED_ENVELOPE] : [401, UNAUTHORIZED_ENVELOPE];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  apiPort = await listen(api);
});
afterAll(() => close(api));

describe('munera-check (A2-374)', () => {
  it('no key → exit 78 MUNERA_CREDENTIAL_MISSING, and no request is sent', async () => {
    const before = seen.length;
    const r = await runMuneraCheck(
      { MUNERA_BASE_URL: `http://127.0.0.1:${apiPort}/api/v1` },
      { probe: true, readFile },
    );
    expect(r.exitCode).toBe(EX_CONFIG);
    expect(r.line).toMatchObject({ ok: false, code: 'MUNERA_CREDENTIAL_MISSING' });
    expect(seen.length).toBe(before);
  });

  it('key present, Muneral silent (ECONNREFUSED) → exit 69 MUNERA_UNREACHABLE', async () => {
    const r = await runMuneraCheck(
      { ...WITH_KEY, MUNERA_BASE_URL: `http://127.0.0.1:${closedPort}/api/v1` },
      { probe: true, readFile, timeoutMs: 2_000 },
    );
    expect(r.exitCode).toBe(EX_UNAVAILABLE);
    expect(r.line).toMatchObject({ ok: false, code: 'MUNERA_UNREACHABLE', source: 'key-file' });
    expect(r.line.detail).toBe('ECONNREFUSED');
  });

  it('the two faults are distinguishable by exit status AND by code', async () => {
    const missing = await runMuneraCheck({}, { probe: true, readFile });
    const silent = await runMuneraCheck(
      { ...WITH_KEY, MUNERA_BASE_URL: `http://127.0.0.1:${closedPort}/api/v1` },
      { probe: true, readFile, timeoutMs: 2_000 },
    );
    expect(missing.exitCode).not.toBe(silent.exitCode);
    expect(missing.line.code).not.toBe(silent.line.code);
  });

  it('403 DIGEST_GRANT_REQUIRED → key accepted (exit 0): the grant is what is missing', async () => {
    const r = await runMuneraCheck(
      { ...WITH_KEY, MUNERA_BASE_URL: `http://127.0.0.1:${apiPort}/api/v1` },
      { probe: true, readFile },
    );
    expect(r.exitCode).toBe(0);
    expect(r.line).toMatchObject({
      ok: true,
      code: 'MUNERA_CREDENTIAL_ACCEPTED',
      status: 403,
      bodyCode: 'DIGEST_GRANT_REQUIRED',
    });
    const last = seen.at(-1);
    expect(last).toMatchObject({ path: '/api/v1/tasks/digest', auth: `Bearer ${KEY}` });
    expect(last?.ua).toBe('aup-orchestrator/1.0');
  });

  it('401 → exit 77 MUNERA_CREDENTIAL_REJECTED', async () => {
    const r = await runMuneraCheck(
      {
        MUNERA_API_TOKEN: 'mun_sk_revoked_example',
        MUNERA_BASE_URL: `http://127.0.0.1:${apiPort}`,
      },
      { probe: true },
    );
    expect(r.exitCode).toBe(EX_NOPERM);
    expect(r.line).toMatchObject({ ok: false, code: 'MUNERA_CREDENTIAL_REJECTED', status: 401 });
  });

  it('a redirecting address (the site shape) → exit 78 MUNERA_BASE_URL_INVALID', async () => {
    const r = await runMuneraCheck(
      { ...WITH_KEY, MUNERA_BASE_URL: `http://127.0.0.1:${apiPort}/site` },
      { probe: true, readFile },
    );
    expect(r.exitCode).toBe(EX_CONFIG);
    expect(r.line).toMatchObject({ code: 'MUNERA_BASE_URL_INVALID', status: 302 });
  });

  it('without --probe: key seen, no request, and the key is never printed', async () => {
    const before = seen.length;
    const r = await runMuneraCheck(WITH_KEY, { probe: false, readFile });
    expect(r.exitCode).toBe(0);
    expect(r.line).toMatchObject({
      code: 'MUNERA_KEY_PRESENT',
      source: 'key-file',
      bytes: KEY.length,
    });
    expect(JSON.stringify(r.line)).not.toContain(KEY);
    expect(seen.length).toBe(before);
  });
});
