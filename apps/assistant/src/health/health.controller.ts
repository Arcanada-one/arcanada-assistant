import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { IScrutatorClient } from '@arcanada/core';

import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../database/redis.service.js';
import { SCRUTATOR_CLIENT } from '../agents/knowledge-agent/knowledge-agent.service.js';

const APP_VERSION = '0.1.0';

interface DepStatus {
  status: 'ok' | 'fail' | 'pending-integration';
  latencyMs?: number;
  error?: string;
  version?: string;
}

interface HealthBody {
  status: 'ok' | 'degraded' | 'fail';
  version: string;
  timestamp: string;
  dependencies: {
    postgres: DepStatus;
    redis: DepStatus;
    scrutator: DepStatus;
    modelConnector: DepStatus;
    opsBot: DepStatus;
    authArcana: DepStatus;
  };
}

interface HealthResponse {
  statusCode: 200 | 503;
  body: HealthBody;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(SCRUTATOR_CLIENT) private readonly scrutator: IScrutatorClient,
  ) {}

  async check(): Promise<HealthResponse> {
    const [pg, rd, sc] = await Promise.all([
      this.prisma.ping(),
      this.redis.ping(),
      this.scrutator.ping().catch((err: unknown) => ({
        ok: false,
        latencyMs: -1,
        error: err instanceof Error ? err.message : String(err),
        version: undefined,
      })),
    ]);

    const dependencies: HealthBody['dependencies'] = {
      postgres: {
        status: pg.ok ? 'ok' : 'fail',
        latencyMs: pg.latencyMs,
        ...(pg.error ? { error: pg.error } : {}),
      },
      redis: {
        status: rd.ok ? 'ok' : 'fail',
        latencyMs: rd.latencyMs,
        ...(rd.error ? { error: rd.error } : {}),
      },
      scrutator: {
        status: sc.ok ? 'ok' : 'fail',
        ...(sc.latencyMs >= 0 ? { latencyMs: sc.latencyMs } : {}),
        ...(sc.version ? { version: sc.version } : {}),
        ...(sc.error ? { error: sc.error } : {}),
      },
      modelConnector: { status: 'pending-integration' },
      opsBot: { status: 'pending-integration' },
      authArcana: { status: 'pending-integration' },
    };

    const allOk = pg.ok && rd.ok && sc.ok;
    const body: HealthBody = {
      status: allOk ? 'ok' : 'fail',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      dependencies,
    };

    return { statusCode: allOk ? 200 : 503, body };
  }

  @Get()
  @HttpCode(200)
  async handle(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthBody> {
    const result = await this.check();
    reply.status(result.statusCode);
    return result.body;
  }
}
