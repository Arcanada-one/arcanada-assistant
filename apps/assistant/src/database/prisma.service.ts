import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import prismaPkg from '@prisma/client';

// CJS interop: Prisma 7's @prisma/client is a CJS module exporting via
// module.exports — under NodeNext ESM only the default import works.
const { PrismaClient } = prismaPkg as unknown as { PrismaClient: new () => PrismaClient };
type PrismaClient = InstanceType<typeof prismaPkg.PrismaClient>;

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(client?: PrismaClient) {
    this.client = client ?? new PrismaClient();
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
