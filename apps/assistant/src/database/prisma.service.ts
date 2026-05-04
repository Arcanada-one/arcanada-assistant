import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import prismaPkg from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

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
    const connectionString = process.env.DATABASE_URL ?? '';
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
