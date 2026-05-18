import { Inject, Injectable, Logger } from '@nestjs/common';

import { TELEGRAM_GATEWAY, type TelegramGateway } from '../../webhook/telegram.gateway.js';
import { ClaudeService } from '../../chat/chat.service.js';
import type { ClaudeContentBlock } from '../../agents/claude/claude.schemas.js';

export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
}

// ARCA-0011 — pre-decode size guard. Raw bytes >20 MB are rejected before
// touching MC to keep upstream OpenRouter latency / cost in check.
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

// Recognise JPEG / PNG / GIF / WebP from magic numbers when Telegram does
// not provide an explicit mime_type (PhotoSize never carries one).
const MIME_FROM_MAGIC: Array<{ matcher: (b: Buffer) => boolean; mime: string }> = [
  {
    matcher: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    mime: 'image/jpeg',
  },
  {
    matcher: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
    mime: 'image/png',
  },
  {
    matcher: (b) =>
      b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
    mime: 'image/gif',
  },
  {
    matcher: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
    mime: 'image/webp',
  },
];

const DEFAULT_CAPTION = 'Опиши изображение по-русски, кратко.';

@Injectable()
export class PhotoHandler {
  private readonly logger = new Logger(PhotoHandler.name);

  constructor(
    @Inject(TELEGRAM_GATEWAY) private readonly telegram: TelegramGateway,
    private readonly chat: ClaudeService,
  ) {}

  async handle(
    chatId: number,
    photos: TelegramPhotoSize[],
    caption: string | undefined,
    userId: number,
  ): Promise<void> {
    if (!photos.length) {
      this.logger.warn({ chatId }, 'photo update missing photo array');
      return;
    }
    const largest = pickLargest(photos);
    let bytes: Buffer;
    try {
      bytes = await this.telegram.getFileBuffer(largest.file_id);
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'photo download failed');
      await this.replySafe(chatId, '⚠️ Не удалось скачать изображение.');
      return;
    }
    if (bytes.byteLength > MAX_PHOTO_BYTES) {
      this.logger.warn({ chatId, size: bytes.byteLength }, 'photo too large');
      await this.replySafe(chatId, '⚠️ Размер изображения превышает предел 20 МБ.');
      return;
    }
    const mime = sniffMime(bytes);
    if (!mime) {
      this.logger.warn({ chatId }, 'unrecognised image mime');
      await this.replySafe(chatId, '⚠️ Неизвестный формат изображения.');
      return;
    }
    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
    const content: ClaudeContentBlock[] = [
      { type: 'text', text: caption?.trim() || DEFAULT_CAPTION },
      { type: 'image_url', image_url: { url: dataUrl } },
    ];
    try {
      const turn = await this.chat.handleTurn(userId, content, { modality: 'photo' });
      this.logger.log(
        {
          modality: 'photo',
          file_size_bytes: bytes.byteLength,
          success: true,
          cost_usd: turn.meta?.costUsd,
          model: turn.meta?.model,
          latency_ms: turn.meta?.latencyMs,
        },
        'photo processed',
      );
      await this.replySafe(chatId, turn.reply || '⚠️ Пустой ответ от Claude.');
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'photo claude turn failed');
      await this.replySafe(chatId, '⚠️ Полный ответ от Claude недоступен.');
    }
  }

  private async replySafe(chatId: number, text: string): Promise<void> {
    try {
      await this.telegram.sendMessage(chatId, text);
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'photo reply failed');
    }
  }
}

function pickLargest(photos: TelegramPhotoSize[]): TelegramPhotoSize {
  return photos.reduce((best, cur) =>
    cur.width * cur.height > best.width * best.height ? cur : best,
  );
}

function sniffMime(bytes: Buffer): string | null {
  for (const { matcher, mime } of MIME_FROM_MAGIC) {
    if (matcher(bytes)) return mime;
  }
  return null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
