import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingEnvError } from '../config/require-env.js';

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

describe('RedisService constructor (A2-226)', () => {
  const saved = process.env.REDIS_URL;

  beforeEach(() => {
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved;
  });

  // On arcana-prd the app shares a host with the production Redis, published on
  // loopback (docker-compose.yml:38). A `?? 'redis://localhost:6379/0'` default
  // therefore aims a process that merely forgot the variable at production.
  it('refuses to construct when REDIS_URL is unset, naming the variable', () => {
    expect(() => new RedisService()).toThrow(MissingEnvError);
    expect(() => new RedisService()).toThrow('REDIS_URL');
  });

  it('never falls back to a localhost default', () => {
    expect(() => new RedisService()).not.toThrow(/localhost/);
    expect(() => new RedisService()).toThrow(/not set/i);
  });

  it('refuses an empty REDIS_URL just as it refuses an absent one', () => {
    process.env.REDIS_URL = '';
    expect(() => new RedisService()).toThrow(MissingEnvError);
  });
});
