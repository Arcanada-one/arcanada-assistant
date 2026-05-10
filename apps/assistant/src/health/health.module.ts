import { Module } from '@nestjs/common';

import { KnowledgeAgentModule } from '../agents/knowledge-agent/knowledge-agent.module.js';

import { HealthController } from './health.controller.js';

@Module({
  imports: [KnowledgeAgentModule],
  controllers: [HealthController],
})
export class HealthModule {}
