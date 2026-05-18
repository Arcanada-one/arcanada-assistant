import { Module } from '@nestjs/common';

import { KnowledgeAgentModule } from '../agents/knowledge-agent/knowledge-agent.module.js';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';

import { AgentPingController } from './agent-ping.controller.js';
import { HealthController } from './health.controller.js';
import { PerAgentHealthIndicator } from './per-agent.health.indicator.js';

@Module({
  imports: [KnowledgeAgentModule, OrchestratorModule],
  controllers: [HealthController, AgentPingController],
  providers: [PerAgentHealthIndicator],
  exports: [PerAgentHealthIndicator],
})
export class HealthModule {}
