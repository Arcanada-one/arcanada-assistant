import { Injectable } from '@nestjs/common';

import { EchoHandler } from '../../webhook/echo.handler.js';

import { AgentsHandler } from './agents.handler.js';
import { StatusHandler } from './status.handler.js';
import { WikiHandler } from './wiki.handler.js';
import { RememberHandler } from './remember.handler.js';

interface IncomingUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    chat?: { id: number };
    from?: { id?: number };
    text?: string;
  };
}

const REMEMBER_NL_PREFIX = /^запомни,?\s+что\s+/iu;

@Injectable()
export class CommandRouter {
  constructor(
    private readonly status: StatusHandler,
    private readonly agents: AgentsHandler,
    private readonly wiki: WikiHandler,
    private readonly remember: RememberHandler,
    private readonly echo: EchoHandler,
  ) {}

  async handle(update: IncomingUpdate): Promise<void> {
    const message = update.message;
    if (!message) return;
    const text = message.text?.trim() ?? '';
    const command = text.split(/\s+/, 1)[0]?.split('@', 1)[0] ?? '';
    const chatId = message.chat?.id;
    const userId = message.from?.id;
    if (chatId !== undefined) {
      if (command === '/status') return await this.status.handle(chatId);
      if (command === '/agents') return await this.agents.handle(chatId);
      if (command === '/wiki') {
        const query = text.slice(command.length).trim();
        return await this.wiki.handle(chatId, query);
      }
      if (command === '/remember') {
        const fact = text.slice(command.length).trim();
        return await this.remember.handle(chatId, userId, fact);
      }
      const nlMatch = REMEMBER_NL_PREFIX.exec(text);
      if (nlMatch) {
        const fact = text.slice(nlMatch[0].length).trim();
        return await this.remember.handle(chatId, userId, fact);
      }
    }
    await this.echo.handle(update as never);
  }
}
