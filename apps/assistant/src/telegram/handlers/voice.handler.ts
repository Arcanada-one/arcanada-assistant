import { Inject, Injectable, Logger } from '@nestjs/common';

import { TELEGRAM_GATEWAY, type TelegramGateway } from '../../webhook/telegram.gateway.js';
import { OrchestratorService } from '../../orchestrator/orchestrator.service.js';
import {
  STT_ALLOWED_MIME,
  type SttMimeType,
  type TranscribeResult,
} from '../../agents/transcriber/transcriber.schemas.js';

export interface TelegramVoice {
  file_id: string;
  mime_type?: string;
  duration: number;
  file_size?: number;
}

const DEFAULT_MIME: SttMimeType = 'audio/ogg';

@Injectable()
export class VoiceHandler {
  private readonly logger = new Logger(VoiceHandler.name);

  constructor(
    @Inject(TELEGRAM_GATEWAY) private readonly telegram: TelegramGateway,
    private readonly orchestrator: OrchestratorService,
  ) {}

  async handle(chatId: number, voice: TelegramVoice): Promise<void> {
    const mime = (voice.mime_type ?? DEFAULT_MIME) as SttMimeType | string;
    if (!isAllowedMime(mime)) {
      await this.replySafe(
        chatId,
        `⚠️ Формат аудио "${mime}" не поддерживается транскрибатором.`,
      );
      return;
    }
    let audio: Buffer;
    try {
      audio = await this.telegram.getFileBuffer(voice.file_id);
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'voice download failed');
      await this.replySafe(chatId, '⚠️ Не удалось скачать голосовое сообщение.');
      return;
    }
    let result: TranscribeResult;
    try {
      result = await this.orchestrator.route<TranscribeResult>('/transcribe', {
        audio,
        mimeType: mime,
        filename: defaultFilename(mime),
      });
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, '/transcribe orchestrator failure');
      await this.replySafe(chatId, '⚠️ Транскрибатор недоступен. Попробуй позже.');
      return;
    }
    await this.replySafe(chatId, render(result));
  }

  private async replySafe(chatId: number, text: string): Promise<void> {
    try {
      await this.telegram.sendMessage(chatId, text);
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'voice reply failed');
    }
  }
}

function isAllowedMime(mime: string): mime is SttMimeType {
  return (STT_ALLOWED_MIME as readonly string[]).includes(mime);
}

function render(result: TranscribeResult): string {
  if (result.kind === 'ok') return result.transcription;
  const detail = result.detail ? ` — ${result.detail}` : '';
  return `⚠️ Транскрибатор недоступен (${result.reason})${detail}.`;
}

function defaultFilename(mime: string): string {
  switch (mime) {
    case 'audio/ogg':
      return 'voice.ogg';
    case 'audio/webm':
      return 'voice.webm';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'voice.wav';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'voice.m4a';
    case 'audio/flac':
    case 'audio/x-flac':
      return 'voice.flac';
    default:
      return 'voice.mp3';
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
