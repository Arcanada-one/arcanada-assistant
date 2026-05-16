import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import dreamerConfig from './config/dreamer.config.js';
import muneraConfig from './config/munera.config.js';
import opsBotConfig from './config/ops-bot.config.js';
import scrutatorConfig from './config/scrutator.config.js';
import transcriberConfig from './config/transcriber.config.js';
import { configurationSchema, validateConfig } from './config/configuration.js';
import { ChatModule } from './chat/chat.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { WebhookModule } from './webhook/webhook.module.js';
import { OrchestratorModule } from './orchestrator/orchestrator.module.js';
import { OpsAgentModule } from './agents/ops-agent/ops-agent.module.js';
import { KnowledgeAgentModule } from './agents/knowledge-agent/knowledge-agent.module.js';
import { TranscriberAgentModule } from './agents/transcriber/transcriber-agent.module.js';
import { MuneraAgentModule } from './agents/munera/munera-agent.module.js';
import { DreamerAgentModule } from './agents/dreamer/dreamer-agent.module.js';
import { ApprovalModule } from './approval/approval.module.js';
import { FatalInterceptor } from './lifecycle/fatal.interceptor.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [opsBotConfig, scrutatorConfig, transcriberConfig, muneraConfig, dreamerConfig],
      validate: (env) => validateConfig(env),
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers["x-telegram-bot-api-secret-token"]',
            'req.headers.cookie',
            '*.DATABASE_URL',
            '*.REDIS_URL',
            '*.TELEGRAM_BOT_TOKEN',
            '*.TELEGRAM_WEBHOOK_SECRET',
            '*.OPSBOT_API_KEY',
          ],
          censor: '[REDACTED]',
        },
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    DatabaseModule,
    HealthModule,
    OrchestratorModule,
    OpsAgentModule,
    KnowledgeAgentModule,
    TranscriberAgentModule,
    MuneraAgentModule,
    DreamerAgentModule,
    ApprovalModule,
    ChatModule,
    WebhookModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: FatalInterceptor,
    },
  ],
})
export class AppModule {
  static configurationSchema = configurationSchema;
}
