import { describe, expect, it, vi } from 'vitest';
import { RedisService } from './redis.service.js';

interface MockRedis {
  ping: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
}

function makeMock(): MockRedis {
  return {
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
  };
}

describe('RedisService', () => {
  it('ping() returns ok=true with latency on PONG response', async () => {
    const mock = makeMock();
    const svc = RedisService.withClient(mock as never);
    const r = await svc.ping();
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('ping() returns ok=false when ping rejects', async () => {
    const mock = makeMock();
    mock.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const svc = RedisService.withClient(mock as never);
    const r = await svc.ping();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });

  it('ping() returns ok=false when reply is not PONG', async () => {
    const mock = makeMock();
    mock.ping.mockResolvedValueOnce('NOPE');
    const svc = RedisService.withClient(mock as never);
    const r = await svc.ping();
    expect(r.ok).toBe(false);
  });

  it('onModuleDestroy calls quit', async () => {
    const mock = makeMock();
    const svc = RedisService.withClient(mock as never);
    await svc.onModuleDestroy();
    expect(mock.quit).toHaveBeenCalledOnce();
  });

  it('exposes the underlying client', () => {
    const mock = makeMock();
    const svc = RedisService.withClient(mock as never);
    expect(svc.client).toBe(mock);
  });
});
