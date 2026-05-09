import { Module } from '@nestjs/common';

import { CommandRouter } from '../telegram/handlers/command-router.handler.js';
import { StatusHandler } from '../telegram/handlers/status.handler.js';
import { AgentsHandler } from '../telegram/handlers/agents.handler.js';
import { OrchestratorModule } from '../orchestrator/orchestrator.module.js';

import { TELEGRAM_GATEWAY, TelegrafGateway } from './telegram.gateway.js';
import { TelegramController } from './telegram.controller.js';
import { EchoHandler } from './echo.handler.js';

@Module({
  imports: [OrchestratorModule],
  controllers: [TelegramController],
  providers: [
    EchoHandler,
    StatusHandler,
    AgentsHandler,
    CommandRouter,
    {
      provide: TELEGRAM_GATEWAY,
      useClass: TelegrafGateway,
    },
  ],
  exports: [EchoHandler, CommandRouter, TELEGRAM_GATEWAY],
})
export class WebhookModule {}
