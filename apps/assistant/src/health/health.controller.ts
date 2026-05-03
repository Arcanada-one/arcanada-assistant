import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../database/redis.service.js';

const APP_VERSION = '0.1.0';

interface DepStatus {
  status: 'ok' | 'fail' | 'pending-integration';
  latencyMs?: number;
  error?: string;
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
  ) {}

  async check(): Promise<HealthResponse> {
    const [pg, rd] = await Promise.all([this.prisma.ping(), this.redis.ping()]);

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
      scrutator: { status: 'pending-integration' },
      modelConnector: { status: 'pending-integration' },
      opsBot: { status: 'pending-integration' },
      authArcana: { status: 'pending-integration' },
    };

    const allOk = pg.ok && rd.ok;
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
