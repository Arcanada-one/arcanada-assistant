import { Module } from '@nestjs/common';

import { KnowledgeAgentModule } from '../agents/knowledge-agent/knowledge-agent.module.js';

import { ClaudeService } from './chat.service.js';

/**
 * Hosts the dialog seam (`ClaudeService`) used by Telegram and (future) web
 * gateways. Imports `KnowledgeAgentModule` to consume `DialogContextService`
 * — that module provides Scrutator-backed LTM recall.
 */
@Module({
  imports: [KnowledgeAgentModule],
  providers: [ClaudeService],
  exports: [ClaudeService],
})
export class ChatModule {}
