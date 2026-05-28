import { timingSafeEqual } from 'node:crypto';

import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';

import { CommandRouter, type IncomingUpdate } from '../telegram/handlers/command-router.handler.js';

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

@ApiTags('webhook')
@Controller('webhook')
export class TelegramController {
  constructor(
    private readonly router: CommandRouter,
    private readonly config: ConfigService,
  ) {}

  @Post('telegram')
  @HttpCode(200)
  async handle(
    @Body() update: IncomingUpdate,
    @Headers('x-telegram-bot-api-secret-token') secret?: string,
  ): Promise<{ ok: true }> {
    const expected = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET') ?? '';
    if (!secret || !expected || !safeEq(secret, expected)) {
      throw new UnauthorizedException('invalid webhook secret');
    }
    // Fire-and-forget: ack <100ms regardless of handler outcome.
    void this.router.handle(update);
    return { ok: true };
  }
}
