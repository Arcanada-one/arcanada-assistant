import { Injectable, Optional } from '@nestjs/common';

import { EchoHandler } from '../../webhook/echo.handler.js';

import { AgentsHandler } from './agents.handler.js';
import { StatusHandler } from './status.handler.js';
import { WikiHandler } from './wiki.handler.js';
import { RememberHandler } from './remember.handler.js';
import { VoiceHandler, type TelegramVoice } from './voice.handler.js';
import { PhotoHandler, type TelegramPhotoSize } from './photo.handler.js';
import { DocumentHandler, type TelegramDocument } from './document.handler.js';
import { TaskHandler } from './task.handler.js';
import { OpsCommandHandler } from './ops-command.handler.js';
import {
  ApprovalCallbackHandler,
  type TelegramCallbackQuery,
} from './approval-callback.handler.js';

export interface IncomingUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    chat?: { id: number };
    from?: { id?: number };
    text?: string;
    caption?: string;
    voice?: TelegramVoice;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
  };
  callback_query?: TelegramCallbackQuery;
}

const REMEMBER_NL_PREFIX = /^запомни,?\s+что\s+/iu;
const TASK_NL_PREFIX = /^создай(те)?\s+задачу[:\s]+/iu;

@Injectable()
export class CommandRouter {
  constructor(
    private readonly status: StatusHandler,
    private readonly agents: AgentsHandler,
    private readonly wiki: WikiHandler,
    private readonly remember: RememberHandler,
    private readonly echo: EchoHandler,
    private readonly voice: VoiceHandler,
    private readonly task: TaskHandler,
    private readonly ops: OpsCommandHandler,
    private readonly approvalCallback: ApprovalCallbackHandler,
    @Optional() private readonly photo?: PhotoHandler,
    @Optional() private readonly document?: DocumentHandler,
  ) {}

  async handle(update: IncomingUpdate): Promise<void> {
    if (update.callback_query) {
      return await this.approvalCallback.handle(update.callback_query);
    }
    const message = update.message;
    if (!message) return;
    if (message.voice && message.chat?.id !== undefined) {
      return await this.voice.handle(message.chat.id, message.voice, message.from?.id);
    }
    if (
      this.photo &&
      message.photo &&
      message.photo.length > 0 &&
      message.chat?.id !== undefined &&
      message.from?.id !== undefined
    ) {
      return await this.photo.handle(
        message.chat.id,
        message.photo,
        message.caption,
        message.from.id,
      );
    }
    if (
      this.document &&
      message.document &&
      message.document.mime_type === 'application/pdf' &&
      message.chat?.id !== undefined &&
      message.from?.id !== undefined
    ) {
      return await this.document.handle(
        message.chat.id,
        message.document,
        message.caption,
        message.from.id,
      );
    }
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
      if (command === '/task') {
        const title = text.slice(command.length).trim();
        return await this.task.handle(chatId, title);
      }
      if (command === '/ops') {
        const args = text.slice(command.length).trim();
        return await this.ops.handle(chatId, args);
      }
      const taskMatch = TASK_NL_PREFIX.exec(text);
      if (taskMatch) {
        const title = text.slice(taskMatch[0].length).trim();
        return await this.task.handle(chatId, title);
      }
      const rememberMatch = REMEMBER_NL_PREFIX.exec(text);
      if (rememberMatch) {
        const fact = text.slice(rememberMatch[0].length).trim();
        return await this.remember.handle(chatId, userId, fact);
      }
    }
    await this.echo.handle(update as never);
  }
}
