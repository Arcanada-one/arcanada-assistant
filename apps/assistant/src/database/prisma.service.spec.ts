import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from './prisma.service.js';

interface MockClient {
  $connect: ReturnType<typeof vi.fn>;
  $disconnect: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
}

function makeMock(): MockClient {
  return {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
}

describe('PrismaService', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('connects on module init', async () => {
    const mock = makeMock();
    const svc = new PrismaService(mock as never);
    await svc.onModuleInit();
    expect(mock.$connect).toHaveBeenCalledOnce();
  });

  it('disconnects on module destroy', async () => {
    const mock = makeMock();
    const svc = new PrismaService(mock as never);
    await svc.onModuleDestroy();
    expect(mock.$disconnect).toHaveBeenCalledOnce();
  });

  it('exposes ping() returning latency', async () => {
    const mock = makeMock();
    const svc = new PrismaService(mock as never);
    const result = await svc.ping();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('ping() returns ok=false on query failure', async () => {
    const mock = makeMock();
    mock.$queryRaw.mockRejectedValueOnce(new Error('connection refused'));
    const svc = new PrismaService(mock as never);
    const result = await svc.ping();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('connection refused');
  });
});
