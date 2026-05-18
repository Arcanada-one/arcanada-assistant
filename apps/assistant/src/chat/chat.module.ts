import { Module } from '@nestjs/common';

import { ClaudeAgentModule } from '../agents/claude/claude-agent.module.js';
import { KnowledgeAgentModule } from '../agents/knowledge-agent/knowledge-agent.module.js';

import { ClaudeService } from './chat.service.js';

@Module({
  imports: [KnowledgeAgentModule, ClaudeAgentModule],
  providers: [ClaudeService],
  exports: [ClaudeService],
})
export class ChatModule {}
