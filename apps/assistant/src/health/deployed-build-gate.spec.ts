// A2-222 — the deploy gate itself, driven against a stub /health.
//
// Green is cheap and proves nothing on its own, so each of these first shows the gate going RED
// for a distinct reason; the pass at the end is then a verdict rather than a default. The stub is
// a real HTTP server on loopback, because the gate's job includes reading a live endpoint and the
// failure modes that matter (no field, null digest, 503, unreachable service) all live on that
// boundary.

import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { fingerprintOf } from './build-fingerprint.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GATE = join(REPO_ROOT, 'scripts', 'ci', 'deployed-build-gate.py');

const REAL_DIGEST = fingerprintOf(REPO_ROOT).digest as string;
const STALE_DIGEST = `sha256:${'0'.repeat(64)}`;

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((done) => server?.close(() => done()));
  server = undefined;
});

/** A loopback /health that answers `payload` with `statusCode` and nothing else. */
async function serve(payload: unknown, statusCode = 200): Promise<string> {
  const body = JSON.stringify(payload);
  server = createServer((_request, response) => {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise<void>((ready) => server?.listen(0, '127.0.0.1', ready));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}/health`;
}

function health(digest: string | null, problems: string[] = []): unknown {
  return {
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    buildFingerprint: {
      digest,
      files: 210,
      root: '/workspace',
      inputs: ['apps/assistant'],
      problems,
    },
  };
}

/** Async on purpose: the stub /health above lives in THIS process, so a synchronous child would
 * block the event loop that has to answer it — the gate would time out against a server that was
 * never given a chance to reply, and every test below would pass for the wrong reason. */
async function runGate(
  url: string,
  root: string = REPO_ROOT,
  attempts = '1',
): Promise<{ code: number; out: string }> {
  const argv = [GATE, '--health-url', url, '--root', root, '--attempts', attempts, '--delay', '0'];
  try {
    const { stdout } = await execFileAsync('python3', argv, { encoding: 'utf8' });
    return { code: 0, out: stdout };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, out: `${failure.stdout}${failure.stderr}` };
  }
}

describe('the deployed-build gate', () => {
  it('PASSES when the running container reports this checkout', async () => {
    // The deploy that landed — and, equally, the docs-only deploy that correctly recreated
    // nothing. Both look exactly like this, which is the whole point.
    const result = await runGate(await serve(health(REAL_DIGEST)));
    expect(result.out).toContain('PASS');
    expect(result.code).toBe(0);
  });

  it('PASSES on a 503, because a degraded upstream is not an undeployed release', async () => {
    // /health answers 503 whenever an owned dependency is down, and the deploy's wait step
    // already accepts that. Refusing to read the body here would turn an unrelated outage into
    // `the deploy did not land` — the very class of false red this gate exists to remove.
    const result = await runGate(await serve(health(REAL_DIGEST), 503));
    expect(result.out).toContain('PASS');
    expect(result.code).toBe(0);
  });

  it('FAILS when the running container reports a different image', async () => {
    // The failure the old age check was reaching for: production serving an older build. Proved
    // with a stale digest rather than by breaking production.
    const result = await runGate(await serve(health(STALE_DIGEST)));
    expect(result.code).toBe(1);
    expect(result.out).toContain("NOT running this commit's image");
    expect(result.out).toContain(STALE_DIGEST);
    expect(result.out).toContain(REAL_DIGEST);
  });

  it('FAILS when the service cannot name its build', async () => {
    // NOT MEASURED is not a pass. The service answered and said it does not know — reported as
    // `could not prove`, which is distinct from `proved wrong`.
    const result = await runGate(
      await serve(health(null, ["declared image input 'packages/core' is missing"])),
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain('could not prove');
    expect(result.out).toContain("declared image input 'packages/core' is missing");
  });

  it('FAILS when /health predates the field', async () => {
    // A container still running a pre-A2-222 image has no `buildFingerprint` to report — which is
    // itself a deploy that did not land, so it must not be waved through.
    const result = await runGate(await serve({ status: 'ok', version: '0.1.0' }));
    expect(result.code).toBe(1);
    expect(result.out).toContain('carries no `buildFingerprint`');
  });

  it('FAILS when the checkout side has no image inputs', async () => {
    // The expectation side can be unmeasurable too, and that is red as well: a gate with nothing
    // to compare against has proved nothing.
    const empty = mkdtempSync(join(tmpdir(), 'assistant-gate-empty-'));
    try {
      const result = await runGate(await serve(health(REAL_DIGEST)), empty);
      expect(result.code).toBe(1);
      expect(result.out).toContain('no digest at the checkout');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('FAILS when the service does not answer', async () => {
    // Port 1 on loopback: nothing listens, connection refused on every attempt.
    const result = await runGate('http://127.0.0.1:1/health', REPO_ROOT, '2');
    expect(result.code).toBe(1);
    expect(result.out).toContain('did not answer with usable JSON after 2 attempts');
  });
});
