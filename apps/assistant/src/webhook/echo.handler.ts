import { Inject, Injectable, Logger } from '@nestjs/common';
import { TELEGRAM_GATEWAY, type TelegramGateway } from './telegram.gateway.js';

const APP_VERSION = '0.1.0';

interface MinimalUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
}

@Injectable()
export class EchoHandler {
  private readonly logger = new Logger(EchoHandler.name);

  constructor(@Inject(TELEGRAM_GATEWAY) private readonly telegram: TelegramGateway) {}

  async handle(update: MinimalUpdate): Promise<void> {
    const message = update.message;
    if (!message) {
      return;
    }
    const reply =
      `Привет! Arcanada Assistant scaffold v${APP_VERSION} — ` +
      'orchestration coming in ARCA-0007.';
    try {
      await this.telegram.sendMessage(message.chat.id, reply);
    } catch (err) {
      this.logger.warn(
        { update_id: update.update_id, err: err instanceof Error ? err.message : String(err) },
        'echo reply failed (fire-and-forget)',
      );
    }
  }
}
