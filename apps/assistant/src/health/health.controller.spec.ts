import { describe, expect, it, vi } from 'vitest';

import type { MeshHealthRollup } from './per-agent.health.indicator.js';
import { HealthController } from './health.controller.js';

const okPrisma = { ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 3 }) };
const okRedis = { ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }) };
const okScrutator = {
  ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 12, version: '0.3.0' }),
};
const emptyMesh = {
  snapshot: vi
    .fn()
    .mockResolvedValue({ status: 'ok', agents: [] } satisfies MeshHealthRollup),
};

function makeMesh(rollup: MeshHealthRollup) {
  return { snapshot: vi.fn().mockResolvedValue(rollup) };
}

describe('HealthController', () => {
  it('returns status=ok when PG, Redis, Scrutator all pass and mesh is empty/ok', async () => {
    const ctl = new HealthController(
      okPrisma as never,
      okRedis as never,
      okScrutator as never,
      emptyMesh as never,
    );
    const result = await ctl.check();
    expect(result.body.status).toBe('ok');
    expect(result.statusCode).toBe(200);
    expect(result.body.dependencies.postgres.status).toBe('ok');
    expect(result.body.dependencies.redis.status).toBe('ok');
    expect(result.body.dependencies.scrutator.status).toBe('ok');
    expect(result.body.dependencies.scrutator.version).toBe('0.3.0');
    expect(result.body.dependencies.scrutator.latencyMs).toBe(12);
    expect(result.body.dependencies.modelConnector.status).toBe('pending-integration');
    expect(result.body.agents).toEqual([]);
  });

  it('returns 503 when Postgres fails', async () => {
    const failPg = { ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 50, error: 'down' }) };
    const ctl = new HealthController(
      failPg as never,
      okRedis as never,
      okScrutator as never,
      emptyMesh as never,
    );
    const result = await ctl.check();
    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('fail');
    expect(result.body.dependencies.postgres.error).toBe('down');
  });

  it('returns 503 when Redis fails', async () => {
    const failRedis = {
      ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 200, error: 'ECONNREFUSED' }),
    };
    const ctl = new HealthController(
      okPrisma as never,
      failRedis as never,
      okScrutator as never,
      emptyMesh as never,
    );
    const result = await ctl.check();
    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('fail');
  });

  it('returns 503 when Scrutator ping returns ok=false', async () => {
    const failScrutator = {
      ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 5_000, error: 'timeout' }),
    };
    const ctl = new HealthController(
      okPrisma as never,
      okRedis as never,
      failScrutator as never,
      emptyMesh as never,
    );
    const result = await ctl.check();
    expect(result.statusCode).toBe(503);
    expect(result.body.dependencies.scrutator.status).toBe('fail');
    expect(result.body.dependencies.scrutator.error).toBe('timeout');
  });

  it('treats Scrutator ping rejection as fail (catch fallback)', async () => {
    const throwScrutator = { ping: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const ctl = new HealthController(
      okPrisma as never,
      okRedis as never,
      throwScrutator as never,
      emptyMesh as never,
    );
    const result = await ctl.check();
    expect(result.statusCode).toBe(503);
    expect(result.body.dependencies.scrutator.status).toBe('fail');
    expect(result.body.dependencies.scrutator.error).toBe('connection refused');
    expect(result.body.dependencies.scrutator.latencyMs).toBeUndefined();
  });

  it('omits scrutator version when ping returns no version', async () => {
    const noVersion = { ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 7 }) };
    const ctl = new HealthController(
      okPrisma as never,
      okRedis as never,
      noVersion as never,
      emptyMesh as never,
    );
    const result = await ctl.check();
    expect(result.body.dependencies.scrutator.status).toBe('ok');
    expect(result.body.dependencies.scrutator.version).toBeUndefined();
  });

  it('response carries version + ISO timestamp', async () => {
    const ctl = new HealthController(
      okPrisma as never,
      okRedis as never,
      okScrutator as never,
      emptyMesh as never,
    );
    const result = await ctl.check();
    expect(result.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(() => new Date(result.body.timestamp).toISOString()).not.toThrow();
  });

  it('downgrades to degraded when an agent is degraded but deps are ok', async () => {
    const mesh = makeMesh({
      status: 'degraded',
      agents: [
        { agent: 'dreamer', state: 'degraded', reason: 'skeleton', checkedAt: 'now' },
      ],
    });
    const ctl = new HealthController(
      okPrisma as never,
      okRedis as never,
      okScrutator as never,
      mesh as never,
    );
    const result = await ctl.check();
    expect(result.body.status).toBe('degraded');
    expect(result.statusCode).toBe(200);
    expect(result.body.agents).toHaveLength(1);
  });

  it('reports fail (503) when an agent rolls up to unavailable', async () => {
    const mesh = makeMesh({
      status: 'fail',
      agents: [
        { agent: 'transcriber', state: 'unavailable', circuit: 'open', checkedAt: 'now' },
      ],
    });
    const ctl = new HealthController(
      okPrisma as never,
      okRedis as never,
      okScrutator as never,
      mesh as never,
    );
    const result = await ctl.check();
    expect(result.body.status).toBe('fail');
    expect(result.statusCode).toBe(503);
  });
});
