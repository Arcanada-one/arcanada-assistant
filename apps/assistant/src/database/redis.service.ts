import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis as RedisCtor, type Redis as RedisClient } from 'ioredis';
import type { ProbeResult } from './prisma.service.js';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: RedisClient;

  constructor(client?: RedisClient) {
    this.client =
      client ??
      new RedisCtor(process.env.REDIS_URL ?? 'redis://localhost:6379/0', {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
      });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async ping(): Promise<ProbeResult> {
    const started = performance.now();
    try {
      const reply = await this.client.ping();
      const latencyMs = Math.round(performance.now() - started);
      if (reply !== 'PONG') {
        return { ok: false, latencyMs, error: `unexpected reply: ${reply}` };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
