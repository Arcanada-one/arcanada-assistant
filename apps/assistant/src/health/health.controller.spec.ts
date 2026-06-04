import { describe, expect, it, vi } from 'vitest';

import type { MeshHealthRollup } from './per-agent.health.indicator.js';
import { HealthController } from './health.controller.js';

const okPrisma = { ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 3 }) };
const okRedis = { ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }) };
const okScrutator = {
  ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 12, version: '0.3.0' }),
};
const okMc = { ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 200 }) };
const okOpsBot = { ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }) };
const okAuth = { ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 190, version: '0.3.0' }) };
/** Mesh with munera registered and healthy — the realistic PROD happy path. */
const okMesh = {
  snapshot: vi.fn().mockResolvedValue({
    status: 'ok',
    agents: [{ agent: 'munera', state: 'ok', circuit: 'closed', checkedAt: 'now' }],
  } satisfies MeshHealthRollup),
};
/** Mesh with no agents at all — munera not registered (integration disabled). */
const emptyMesh = {
  snapshot: vi.fn().mockResolvedValue({ status: 'ok', agents: [] } satisfies MeshHealthRollup),
};

function makeMesh(rollup: MeshHealthRollup) {
  return { snapshot: vi.fn().mockResolvedValue(rollup) };
}

/** Construct a controller; any arg may be overridden, rest default to the ok-mocks. */
function makeController(over: Partial<Record<string, unknown>> = {}) {
  return new HealthController(
    (over.prisma ?? okPrisma) as never,
    (over.redis ?? okRedis) as never,
    (over.scrutator ?? okScrutator) as never,
    (over.mc ?? okMc) as never,
    (over.opsBot ?? okOpsBot) as never,
    (over.auth ?? okAuth) as never,
    (over.mesh ?? okMesh) as never,
  );
}

describe('HealthController', () => {
  it('returns status=ok when all hard deps pass and mesh is empty/ok', async () => {
    const result = await makeController().check();
    expect(result.body.status).toBe('ok');
    expect(result.statusCode).toBe(200);
    expect(result.body.dependencies.postgres.status).toBe('ok');
    expect(result.body.dependencies.redis.status).toBe('ok');
    expect(result.body.dependencies.scrutator.status).toBe('ok');
    expect(result.body.dependencies.scrutator.version).toBe('0.3.0');
    expect(result.body.dependencies.scrutator.latencyMs).toBe(12);
    expect(result.body.dependencies.munera.status).toBe('ok');
  });

  // ── ARCA-0127: real probes for MC / OpsBot / AuthArcana (no hardcoded literal) ──

  it('reports real ok statuses for modelConnector, opsBot, authArcana (no pending-integration)', async () => {
    const result = await makeController().check();
    expect(result.body.dependencies.modelConnector.status).toBe('ok');
    expect(result.body.dependencies.modelConnector.latencyMs).toBe(200);
    expect(result.body.dependencies.opsBot.status).toBe('ok');
    expect(result.body.dependencies.authArcana.status).toBe('ok');
    expect(result.body.dependencies.authArcana.version).toBe('0.3.0');
    // no value should ever be the old hardcoded literal
    const serialised = JSON.stringify(result.body.dependencies);
    expect(serialised).not.toContain('pending-integration');
  });

  it('REPORTED-ONLY: modelConnector down → mc.status=fail, HTTP 200, top-level degraded (no 503)', async () => {
    const failMc = {
      ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 2000, error: 'timeout' }),
    };
    const result = await makeController({ mc: failMc }).check();
    expect(result.body.dependencies.modelConnector.status).toBe('fail');
    expect(result.body.dependencies.modelConnector.error).toBe('timeout');
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('degraded');
  });

  it('REPORTED-ONLY: opsBot down → opsBot.status=fail, HTTP 200, degraded', async () => {
    const failOps = {
      ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 2000, error: 'down' }),
    };
    const result = await makeController({ opsBot: failOps }).check();
    expect(result.body.dependencies.opsBot.status).toBe('fail');
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('degraded');
  });

  it('REPORTED-ONLY: authArcana down → authArcana.status=fail, HTTP 200, degraded', async () => {
    const failAuth = {
      ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 2000, error: 'tls' }),
    };
    const result = await makeController({ auth: failAuth }).check();
    expect(result.body.dependencies.authArcana.status).toBe('fail');
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('degraded');
  });

  it('treats an aux-dep ping rejection as fail (catch fallback), still HTTP 200', async () => {
    const throwMc = { ping: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const result = await makeController({ mc: throwMc }).check();
    expect(result.body.dependencies.modelConnector.status).toBe('fail');
    expect(result.body.dependencies.modelConnector.error).toBe('connection refused');
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('degraded');
  });

  // ── ARCA-0127 D5: munera projected from mesh circuit state into .dependencies ──

  it('projects munera from mesh agents into .dependencies (circuit closed → ok)', async () => {
    const mesh = makeMesh({
      status: 'ok',
      agents: [{ agent: 'munera', state: 'ok', circuit: 'closed', checkedAt: 'now' }],
    });
    const result = await makeController({ mesh }).check();
    expect(result.body.dependencies.munera.status).toBe('ok');
    expect(result.statusCode).toBe(200);
  });

  it('munera circuit open → dependencies.munera degraded, HTTP 200 (REPORTED-ONLY)', async () => {
    const mesh = makeMesh({
      // mesh rollup stays 'degraded' (not 'fail') so the 503 gate is not tripped
      status: 'degraded',
      agents: [{ agent: 'munera', state: 'degraded', circuit: 'open', checkedAt: 'now' }],
    });
    const result = await makeController({ mesh }).check();
    expect(result.body.dependencies.munera.status).toBe('degraded');
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('degraded');
  });

  it('munera absent from mesh → dependencies.munera reported as fail (not silently ok)', async () => {
    const result = await makeController({ mesh: emptyMesh }).check();
    expect(result.body.dependencies.munera.status).toBe('fail');
    // still no 503 — munera is REPORTED-ONLY
    expect(result.statusCode).toBe(200);
  });

  // ── 503 gate unchanged: only pg / redis / scrutator (the hard deps) ──

  it('returns 503 when Postgres fails', async () => {
    const failPg = { ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 50, error: 'down' }) };
    const result = await makeController({ prisma: failPg }).check();
    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('fail');
    expect(result.body.dependencies.postgres.error).toBe('down');
  });

  it('returns 503 when Redis fails', async () => {
    const failRedis = {
      ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 200, error: 'ECONNREFUSED' }),
    };
    const result = await makeController({ redis: failRedis }).check();
    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('fail');
  });

  it('returns 503 when Scrutator ping returns ok=false', async () => {
    const failScrutator = {
      ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 5_000, error: 'timeout' }),
    };
    const result = await makeController({ scrutator: failScrutator }).check();
    expect(result.statusCode).toBe(503);
    expect(result.body.dependencies.scrutator.status).toBe('fail');
    expect(result.body.dependencies.scrutator.error).toBe('timeout');
  });

  it('aux dep down does NOT contribute to 503 even when a hard dep is borderline', async () => {
    // all hard deps ok, every aux dep down → still 200/degraded (the core D3 guard)
    const failMc = { ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 1, error: 'x' }) };
    const failOps = { ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 1, error: 'x' }) };
    const failAuth = { ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 1, error: 'x' }) };
    const result = await makeController({ mc: failMc, opsBot: failOps, auth: failAuth }).check();
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('degraded');
  });

  it('treats Scrutator ping rejection as fail (catch fallback)', async () => {
    const throwScrutator = { ping: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const result = await makeController({ scrutator: throwScrutator }).check();
    expect(result.statusCode).toBe(503);
    expect(result.body.dependencies.scrutator.status).toBe('fail');
    expect(result.body.dependencies.scrutator.error).toBe('connection refused');
    expect(result.body.dependencies.scrutator.latencyMs).toBeUndefined();
  });

  it('omits scrutator version when ping returns no version', async () => {
    const noVersion = { ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 7 }) };
    const result = await makeController({ scrutator: noVersion }).check();
    expect(result.body.dependencies.scrutator.status).toBe('ok');
    expect(result.body.dependencies.scrutator.version).toBeUndefined();
  });

  it('response carries version + ISO timestamp', async () => {
    const result = await makeController().check();
    expect(result.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(() => new Date(result.body.timestamp).toISOString()).not.toThrow();
  });

  it('downgrades to degraded when an agent is degraded but deps are ok', async () => {
    const mesh = makeMesh({
      status: 'degraded',
      agents: [{ agent: 'dreamer', state: 'degraded', reason: 'skeleton', checkedAt: 'now' }],
    });
    const result = await makeController({ mesh }).check();
    expect(result.body.status).toBe('degraded');
    expect(result.statusCode).toBe(200);
    expect(result.body.agents).toHaveLength(1);
  });

  it('reports fail (503) when an agent rolls up to unavailable', async () => {
    const mesh = makeMesh({
      status: 'fail',
      agents: [{ agent: 'transcriber', state: 'unavailable', circuit: 'open', checkedAt: 'now' }],
    });
    const result = await makeController({ mesh }).check();
    expect(result.body.status).toBe('fail');
    expect(result.statusCode).toBe(503);
  });
});
