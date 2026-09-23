import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis as RedisCtor, type Redis as RedisClient } from 'ioredis';

import { requireEnv } from '../config/require-env.js';

import type { ProbeResult } from './prisma.service.js';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: RedisClient;

  constructor() {
    // A2-226: no localhost fallback. On arcana-prd the production Redis is
    // published on loopback (docker-compose.yml:38), so defaulting to
    // redis://localhost:6379 would silently connect a misconfigured process to
    // production instead of failing. requireEnv refuses, naming the variable.
    this.client = new RedisCtor(requireEnv('REDIS_URL'), {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
  }

  /** Test-only: substitute a mock client. */
  static withClient(client: RedisClient): RedisService {
    const svc = Object.create(RedisService.prototype) as RedisService;
    (svc as { client: RedisClient }).client = client;
    return svc;
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
