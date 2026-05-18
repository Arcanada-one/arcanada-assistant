import { Injectable } from '@nestjs/common';
import { Telegraf } from 'telegraf';

export interface TelegramSendResult {
  ok: true;
  messageId: number;
}

export interface TelegramSendError {
  ok: false;
  errorCode: number;
  description: string;
  retryAfter?: number;
}

export type TelegramSendOutcome = TelegramSendResult | TelegramSendError;

export const PROACTIVE_TELEGRAM_SENDER = Symbol.for('PROACTIVE_TELEGRAM_SENDER');

export interface IProactiveTelegramSender {
  send(
    chatId: number | string,
    text: string,
    parseMode: 'MarkdownV2' | null,
  ): Promise<TelegramSendOutcome>;
}

@Injectable()
export class ProactiveTelegramSender implements IProactiveTelegramSender {
  private readonly bot: Telegraf;

  constructor() {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN ?? '');
  }

  async send(
    chatId: number | string,
    text: string,
    parseMode: 'MarkdownV2' | null,
  ): Promise<TelegramSendOutcome> {
    try {
      const message = await this.bot.telegram.sendMessage(chatId, text, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        disable_web_page_preview: true,
      } as Parameters<typeof this.bot.telegram.sendMessage>[2]);
      return { ok: true, messageId: message.message_id };
    } catch (err) {
      return this.adaptError(err);
    }
  }

  private adaptError(err: unknown): TelegramSendError {
    const e = err as {
      response?: {
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
      };
    };
    const code = e.response?.error_code ?? 500;
    const description = e.response?.description ?? (err as Error).message ?? 'unknown';
    const retryAfter = e.response?.parameters?.retry_after;
    return {
      ok: false,
      errorCode: code,
      description,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }
}
