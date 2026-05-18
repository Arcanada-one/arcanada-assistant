import { Inject, Injectable, Logger } from '@nestjs/common';

import { TELEGRAM_GATEWAY, type TelegramGateway } from '../../webhook/telegram.gateway.js';
import { ClaudeService } from '../../chat/chat.service.js';

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

// ARCA-0011 PDF safety bounds.
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 25;
const MAX_TEXT_TOKENS = 100_000; // estimated as `text.length / 4`

const PDF_MIME = 'application/pdf';
const DEFAULT_QUESTION =
  'Резюмируй документ кратко по-русски: ключевые тезисы, выводы, цифры.';

@Injectable()
export class DocumentHandler {
  private readonly logger = new Logger(DocumentHandler.name);

  constructor(
    @Inject(TELEGRAM_GATEWAY) private readonly telegram: TelegramGateway,
    private readonly chat: ClaudeService,
  ) {}

  async handle(
    chatId: number,
    doc: TelegramDocument,
    caption: string | undefined,
    userId: number,
  ): Promise<void> {
    if (doc.mime_type !== PDF_MIME) {
      this.logger.warn(
        { chatId, mime: doc.mime_type },
        'unsupported document mime',
      );
      await this.replySafe(chatId, '⚠️ Поддерживаются только PDF-документы.');
      return;
    }
    if (doc.file_size !== undefined && doc.file_size > MAX_PDF_BYTES) {
      await this.replySafe(
        chatId,
        '⚠️ Документ слишком большой (>20 МБ).',
      );
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await this.telegram.getFileBuffer(doc.file_id);
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'document download failed');
      await this.replySafe(chatId, '⚠️ Не удалось скачать документ.');
      return;
    }
    if (bytes.byteLength > MAX_PDF_BYTES) {
      await this.replySafe(chatId, '⚠️ Документ слишком большой (>20 МБ).');
      return;
    }

    let text: string;
    let pages: number;
    try {
      const result = await extractPdfText(bytes);
      text = result.text;
      pages = result.totalPages;
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'pdf extract failed');
      await this.replySafe(
        chatId,
        '⚠️ Не удалось извлечь текст из PDF (зашифрован / только изображения).',
      );
      return;
    }

    if (pages > MAX_PAGES) {
      await this.replySafe(chatId, '⚠️ Документ слишком большой (>25 страниц).');
      return;
    }
    const approxTokens = Math.ceil(text.length / 4);
    if (approxTokens > MAX_TEXT_TOKENS) {
      await this.replySafe(
        chatId,
        '⚠️ Документ слишком длинный (>100k токенов).',
      );
      return;
    }
    if (text.trim().length === 0) {
      await this.replySafe(
        chatId,
        '⚠️ Не удалось извлечь текст из PDF (зашифрован / только изображения).',
      );
      return;
    }

    const question = caption?.trim() || DEFAULT_QUESTION;
    const composed = `${question}\n\n---\n[PDF "${doc.file_name ?? 'document.pdf'}", ${pages} стр.]\n\n${text}`;
    try {
      const turn = await this.chat.handleTurn(userId, composed, {
        modality: 'document',
      });
      this.logger.log(
        {
          modality: 'document',
          file_size_bytes: bytes.byteLength,
          pages,
          success: true,
          cost_usd: turn.meta?.costUsd,
          model: turn.meta?.model,
          latency_ms: turn.meta?.latencyMs,
        },
        'document processed',
      );
      await this.replySafe(chatId, turn.reply || '⚠️ Пустой ответ от Claude.');
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'document claude turn failed');
      await this.replySafe(chatId, '⚠️ Полный ответ от Claude недоступен.');
    }
  }

  private async replySafe(chatId: number, text: string): Promise<void> {
    try {
      await this.telegram.sendMessage(chatId, text);
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'document reply failed');
    }
  }
}

interface PdfExtractResult {
  text: string;
  totalPages: number;
}

// Hoisted hook so tests can inject a stub without dynamically importing unpdf
// (which fails in vitest's worker isolate when @napi-rs/canvas is absent).
export type PdfExtractor = (buf: Buffer) => Promise<PdfExtractResult>;

let pdfExtractor: PdfExtractor = async (buf) => {
  const unpdf = await import('unpdf');
  const proxy = await unpdf.getDocumentProxy(new Uint8Array(buf));
  const out = await unpdf.extractText(proxy, { mergePages: true });
  const merged = Array.isArray(out.text) ? out.text.join('\n') : out.text;
  return { text: merged, totalPages: out.totalPages };
};

export function setPdfExtractor(impl: PdfExtractor): void {
  pdfExtractor = impl;
}

function extractPdfText(buf: Buffer): Promise<PdfExtractResult> {
  return pdfExtractor(buf);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
