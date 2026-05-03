import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';

const okPrisma = { ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 3 }) };
const okRedis = { ping: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }) };

describe('HealthController', () => {
  it('returns status=ok when both PG and Redis pass', async () => {
    const ctl = new HealthController(okPrisma as never, okRedis as never);
    const result = await ctl.check();
    expect(result.body.status).toBe('ok');
    expect(result.statusCode).toBe(200);
    expect(result.body.dependencies.postgres.status).toBe('ok');
    expect(result.body.dependencies.redis.status).toBe('ok');
    expect(result.body.dependencies.modelConnector.status).toBe('pending-integration');
  });

  it('returns status=fail and 503 when Postgres fails', async () => {
    const failPg = { ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 50, error: 'down' }) };
    const ctl = new HealthController(failPg as never, okRedis as never);
    const result = await ctl.check();
    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('fail');
    expect(result.body.dependencies.postgres.error).toBe('down');
  });

  it('returns 503 when Redis fails', async () => {
    const failRedis = { ping: vi.fn().mockResolvedValue({ ok: false, latencyMs: 200, error: 'ECONNREFUSED' }) };
    const ctl = new HealthController(okPrisma as never, failRedis as never);
    const result = await ctl.check();
    expect(result.statusCode).toBe(503);
    expect(result.body.status).toBe('fail');
  });

  it('response carries version + ISO timestamp', async () => {
    const ctl = new HealthController(okPrisma as never, okRedis as never);
    const result = await ctl.check();
    expect(result.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(() => new Date(result.body.timestamp).toISOString()).not.toThrow();
  });
});
