import { Module } from '@nestjs/common';

import { AgentRegistry } from './agent.registry.js';
import { OrchestratorService } from './orchestrator.service.js';

@Module({
  providers: [AgentRegistry, OrchestratorService],
  exports: [AgentRegistry, OrchestratorService],
})
export class OrchestratorModule {}
