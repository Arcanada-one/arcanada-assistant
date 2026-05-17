import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CommandRouter } from '../telegram/handlers/command-router.handler.js';
import { StatusHandler } from '../telegram/handlers/status.handler.js';
import { AgentsHandler } from '../telegram/handlers/agents.handler.js';
import { WikiHandler } from '../telegram/handlers/wiki.handler.js';
import { RememberHandler } from '../telegram/handlers/remember.handler.js';
import { VoiceHandler } from '../telegram/handlers/voice.handler.js';
import { TaskHandler, MUNERA_DEFAULT_PROJECT_ID } from '../telegram/handlers/task.handler.js';
import { ApprovalCallbackHandler } from '../telegram/handlers/approval-callback.handler.js';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';
import { ApprovalModule } from '../approval/approval.module.js';

import { TELEGRAM_GATEWAY, TelegrafGateway } from './telegram.gateway.js';
import { TelegramController } from './telegram.controller.js';
import { EchoHandler } from './echo.handler.js';

@Module({
  imports: [OrchestratorModule, ApprovalModule],
  controllers: [TelegramController],
  providers: [
    EchoHandler,
    StatusHandler,
    AgentsHandler,
    WikiHandler,
    RememberHandler,
    VoiceHandler,
    TaskHandler,
    ApprovalCallbackHandler,
    CommandRouter,
    {
      provide: TELEGRAM_GATEWAY,
      useClass: TelegrafGateway,
    },
    {
      provide: MUNERA_DEFAULT_PROJECT_ID,
      inject: [ConfigService],
      useFactory: (config: ConfigService): string | undefined =>
        config.get<string>('MUNERA_DEFAULT_PROJECT_ID'),
    },
  ],
  exports: [EchoHandler, CommandRouter, TELEGRAM_GATEWAY],
})
export class WebhookModule {}
