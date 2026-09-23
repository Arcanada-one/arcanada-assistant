import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingEnvError } from '../config/require-env.js';

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
    const svc = PrismaService.withClient(mock as never);
    await svc.onModuleInit();
    expect(mock.$connect).toHaveBeenCalledOnce();
  });

  it('disconnects on module destroy', async () => {
    const mock = makeMock();
    const svc = PrismaService.withClient(mock as never);
    await svc.onModuleDestroy();
    expect(mock.$disconnect).toHaveBeenCalledOnce();
  });

  it('exposes ping() returning latency', async () => {
    const mock = makeMock();
    const svc = PrismaService.withClient(mock as never);
    const result = await svc.ping();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('ping() returns ok=false on query failure', async () => {
    const mock = makeMock();
    mock.$queryRaw.mockRejectedValueOnce(new Error('connection refused'));
    const svc = PrismaService.withClient(mock as never);
    const result = await svc.ping();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('connection refused');
  });
});

describe('PrismaService constructor (A2-226)', () => {
  const saved = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  // An empty connection string is not inert: node-postgres resolves it to the
  // ambient libpq defaults, i.e. localhost:5432 as the OS user. On arcana-prd
  // that is the production database (docker-compose.yml:15). Measured in A2-226:
  // with DATABASE_URL unset the adapter reached a real server and failed at the
  // SASL password exchange, not at "no database configured".
  it('refuses to construct when DATABASE_URL is unset, naming the variable', () => {
    expect(() => new PrismaService()).toThrow(MissingEnvError);
    expect(() => new PrismaService()).toThrow('DATABASE_URL');
  });

  it('refuses an empty DATABASE_URL instead of passing it to the driver', () => {
    process.env.DATABASE_URL = '';
    expect(() => new PrismaService()).toThrow(MissingEnvError);
  });
});
