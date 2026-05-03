import { Module } from '@nestjs/common';
import { EchoHandler } from './echo.handler.js';
import { TelegramController } from './telegram.controller.js';
import { TELEGRAM_GATEWAY, TelegrafGateway } from './telegram.gateway.js';

@Module({
  controllers: [TelegramController],
  providers: [
    EchoHandler,
    {
      provide: TELEGRAM_GATEWAY,
      useClass: TelegrafGateway,
    },
  ],
  exports: [EchoHandler, TELEGRAM_GATEWAY],
})
export class WebhookModule {}
