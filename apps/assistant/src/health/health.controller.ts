import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type {
  IHttpHealthClient,
  IOpsBotClient,
  IScrutatorClient,
  PingResult,
} from '@arcanada/core';

import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../database/redis.service.js';
import { SCRUTATOR_CLIENT } from '../agents/knowledge-agent/knowledge-agent.service.js';
import { OPS_BOT_CLIENT } from '../agents/ops-agent/ops-agent.service.js';
import type { AgentHealthSnapshot } from '../aal/agent-health.types.js';

import { PerAgentHealthIndicator } from './per-agent.health.indicator.js';
import {
  AUTH_ARCANA_HEALTH_CLIENT,
  MODEL_CONNECTOR_HEALTH_CLIENT,
} from './health.tokens.js';

const APP_VERSION = '0.1.0';

interface DepStatus {
  status: 'ok' | 'fail' | 'degraded';
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
    munera: DepStatus;
  };
  agents: AgentHealthSnapshot[];
}

interface HealthResponse {
  statusCode: 200 | 503;
  body: HealthBody;
}

/** Map a PingResult into the DepStatus shape (used for the aux upstreams). */
function depFromPing(ping: PingResult): DepStatus {
  return {
    status: ping.ok ? 'ok' : 'fail',
    ...(ping.latencyMs >= 0 ? { latencyMs: ping.latencyMs } : {}),
    ...(ping.version ? { version: ping.version } : {}),
    ...(ping.error ? { error: ping.error } : {}),
  };
}

const failPing = (err: unknown): PingResult => ({
  ok: false,
  latencyMs: -1,
  error: err instanceof Error ? err.message : String(err),
});

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(SCRUTATOR_CLIENT) private readonly scrutator: IScrutatorClient,
    @Inject(MODEL_CONNECTOR_HEALTH_CLIENT) private readonly modelConnector: IHttpHealthClient,
    @Inject(OPS_BOT_CLIENT) private readonly opsBot: IOpsBotClient,
    @Inject(AUTH_ARCANA_HEALTH_CLIENT) private readonly authArcana: IHttpHealthClient,
    private readonly perAgentHealth: PerAgentHealthIndicator,
  ) {}

  async check(): Promise<HealthResponse> {
    const [pg, rd, sc, mc, ob, aa, mesh] = await Promise.all([
      this.prisma.ping(),
      this.redis.ping(),
      this.scrutator.ping().catch(failPing),
      // ARCA-0127: real liveness probes. REPORTED-ONLY — these never gate 503.
      this.modelConnector.ping().catch(failPing),
      this.opsBot.ping().catch(failPing),
      this.authArcana.ping().catch(failPing),
      this.perAgentHealth.snapshot(),
    ]);

    // ARCA-0127 (D5): project munera's circuit state from the mesh rollup into
    // .dependencies (no separate HTTP probe — munera is a consumer-agent whose
    // functional path is owned by the MUN-* tasks). Absent agent → fail (honest).
    const muneraSnapshot = mesh.agents.find((a) => a.agent === 'munera');
    const muneraDep: DepStatus = muneraSnapshot
      ? {
          status:
            muneraSnapshot.state === 'ok'
              ? 'ok'
              : muneraSnapshot.state === 'degraded'
                ? 'degraded'
                : 'fail',
        }
      : { status: 'fail', error: 'munera agent not registered in mesh' };

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
      modelConnector: depFromPing(mc),
      opsBot: depFromPing(ob),
      authArcana: depFromPing(aa),
      munera: muneraDep,
    };

    // 503 gate is UNCHANGED (D3 REPORTED-ONLY): only the assistant's own hard
    // dependencies (its Postgres, its Redis, and Scrutator) flip 200 ⇄ 503.
    const depsOk = pg.ok && rd.ok && sc.ok;
    // Aux upstreams + munera are REPORTED-ONLY: a fault downgrades the top-level
    // rollup to `degraded` but never to `fail` and never produces a 503.
    const auxDepsOk = mc.ok && ob.ok && aa.ok && muneraDep.status === 'ok';
    const meshOk = mesh.status === 'ok';

    const status: HealthBody['status'] = !depsOk
      ? 'fail'
      : mesh.status === 'fail'
        ? 'fail'
        : meshOk && auxDepsOk
          ? 'ok'
          : 'degraded';
    const httpStatus = status === 'fail' ? 503 : 200;
    const body: HealthBody = {
      status,
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      dependencies,
      agents: mesh.agents,
    };

    return { statusCode: httpStatus, body };
  }

  @Get()
  @HttpCode(200)
  async handle(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthBody> {
    const result = await this.check();
    reply.status(result.statusCode);
    return result.body;
  }
}
