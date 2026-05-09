import { Injectable } from '@nestjs/common';

import { EchoHandler } from '../../webhook/echo.handler.js';

import { AgentsHandler } from './agents.handler.js';
import { StatusHandler } from './status.handler.js';

interface IncomingUpdate {
  update_id: number;
  message?: { message_id?: number; chat?: { id: number }; text?: string };
}

@Injectable()
export class CommandRouter {
  constructor(
    private readonly status: StatusHandler,
    private readonly agents: AgentsHandler,
    private readonly echo: EchoHandler,
  ) {}

  async handle(update: IncomingUpdate): Promise<void> {
    const message = update.message;
    if (!message) return;
    const text = message.text?.trim() ?? '';
    const command = text.split(/\s+/, 1)[0]?.split('@', 1)[0] ?? '';
    const chatId = message.chat?.id;
    if (chatId !== undefined) {
      if (command === '/status') return await this.status.handle(chatId);
      if (command === '/agents') return await this.agents.handle(chatId);
    }
    await this.echo.handle(update as never);
  }
}
