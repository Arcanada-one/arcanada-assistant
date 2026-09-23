import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import prismaPkg from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { requireEnv } from '../config/require-env.js';

// CJS interop: Prisma 7's @prisma/client is CJS — under NodeNext ESM only
// the default import works. @prisma/adapter-pg already exports ESM-friendly.
const { PrismaClient } = prismaPkg as unknown as {
  PrismaClient: new (opts: { adapter: unknown }) => PrismaClient;
};
type PrismaClient = InstanceType<typeof prismaPkg.PrismaClient>;

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor() {
    // A2-226: an empty connection string is not inert — node-postgres resolves
    // it to the ambient libpq defaults, i.e. localhost:5432 as the OS user,
    // which on arcana-prd is the production database (docker-compose.yml:15).
    // Measured: with DATABASE_URL unset the adapter reached a real server and
    // failed at the SASL password exchange, not at "no database configured".
    const connectionString = requireEnv('DATABASE_URL');
    const adapter = new PrismaPg({ connectionString });
    this.client = new PrismaClient({ adapter });
  }

  /** Test-only: substitute a mock client. */
  static withClient(client: PrismaClient): PrismaService {
    const svc = Object.create(PrismaService.prototype) as PrismaService;
    (svc as { client: PrismaClient }).client = client;
    return svc;
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  async ping(): Promise<ProbeResult> {
    const started = performance.now();
    try {
      await this.client.$queryRaw`SELECT 1`;
      return { ok: true, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
