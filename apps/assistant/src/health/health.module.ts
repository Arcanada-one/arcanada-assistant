import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpHealthClient, type IHttpHealthClient } from '@arcanada/core';

import { KnowledgeAgentModule } from '../agents/knowledge-agent/knowledge-agent.module.js';
import { OpsAgentModule } from '../agents/ops-agent/ops-agent.module.js';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';

import { AgentPingController } from './agent-ping.controller.js';
import { HealthController } from './health.controller.js';
import { PerAgentHealthIndicator } from './per-agent.health.indicator.js';
import { AUTH_ARCANA_HEALTH_CLIENT, MODEL_CONNECTOR_HEALTH_CLIENT } from './health.tokens.js';

@Module({
  // OpsAgentModule exports OPS_BOT_CLIENT (consumed by HealthController for the
  // structured ping). Model Connector + Auth Arcana liveness clients are
  // provided locally below as plain HttpHealthClient probes.
  imports: [KnowledgeAgentModule, OpsAgentModule, OrchestratorModule],
  controllers: [HealthController, AgentPingController],
  providers: [
    PerAgentHealthIndicator,
    {
      provide: MODEL_CONNECTOR_HEALTH_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): IHttpHealthClient =>
        new HttpHealthClient({
          baseUrl: config.getOrThrow<string>('MODEL_CONNECTOR_HEALTH_URL'),
        }),
    },
    {
      provide: AUTH_ARCANA_HEALTH_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): IHttpHealthClient =>
        new HttpHealthClient({
          baseUrl: config.getOrThrow<string>('AUTH_ARCANA_BASE_URL'),
        }),
    },
  ],
  exports: [PerAgentHealthIndicator],
})
export class HealthModule {}
