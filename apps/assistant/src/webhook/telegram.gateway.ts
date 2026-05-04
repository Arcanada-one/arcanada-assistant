import { Injectable } from '@nestjs/common';
import { Telegraf } from 'telegraf';

export const TELEGRAM_GATEWAY = Symbol.for('TELEGRAM_GATEWAY');

export interface TelegramGateway {
  sendMessage(chatId: number, text: string): Promise<void>;
}

@Injectable()
export class TelegrafGateway implements TelegramGateway {
  private readonly bot: Telegraf;

  constructor() {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN ?? '');
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.bot.telegram.sendMessage(chatId, text);
  }
}
