import { Injectable } from '@nestjs/common';
import { Telegraf } from 'telegraf';

export const TELEGRAM_GATEWAY = Symbol.for('TELEGRAM_GATEWAY');

export interface InlineKeyboardButton {
  text: string;
  callbackData: string;
}

export interface TelegramGateway {
  sendMessage(chatId: number, text: string): Promise<void>;
  sendMessageWithKeyboard(
    chatId: number,
    text: string,
    rows: InlineKeyboardButton[][],
  ): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  getFileBuffer(fileId: string): Promise<Buffer>;
}

@Injectable()
export class TelegrafGateway implements TelegramGateway {
  private readonly bot: Telegraf;
  private readonly token: string;

  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN ?? '';
    this.bot = new Telegraf(this.token);
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.bot.telegram.sendMessage(chatId, text);
  }

  async sendMessageWithKeyboard(
    chatId: number,
    text: string,
    rows: InlineKeyboardButton[][],
  ): Promise<void> {
    const inline_keyboard = rows.map((row) =>
      row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
    );
    await this.bot.telegram.sendMessage(chatId, text, {
      reply_markup: { inline_keyboard },
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.bot.telegram.answerCbQuery(callbackQueryId, text);
  }

  async getFileBuffer(fileId: string): Promise<Buffer> {
    const fileLink = await this.bot.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.toString());
    if (!response.ok) {
      throw new Error(`telegram getFile fetch ${response.status}`);
    }
    const arr = await response.arrayBuffer();
    return Buffer.from(arr);
  }
}
