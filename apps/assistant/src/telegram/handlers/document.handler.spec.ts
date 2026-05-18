import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TelegramGateway } from '../../webhook/telegram.gateway.js';
import type { ClaudeService } from '../../chat/chat.service.js';

import {
  DocumentHandler,
  setPdfExtractor,
  type TelegramDocument,
} from './document.handler.js';

function makeGateway(
  overrides: Partial<TelegramGateway> = {},
  fileBuffer: Buffer = Buffer.from('%PDF-1.7\n…fake…'),
): TelegramGateway {
  return {
    sendMessage: vi.fn(async () => undefined),
    sendMessageWithKeyboard: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined),
    getFileBuffer: vi.fn(async () => fileBuffer),
    ...overrides,
  };
}

function makeChat(): ClaudeService {
  return {
    handleTurn: vi.fn(async () => ({
      systemPrompt: 'sp',
      userMessage: 'q',
      reply: 'Сводка готова.',
      ragApplied: false,
      meta: { model: 'm', costUsd: 0.002, latencyMs: 300 },
    })),
  } as unknown as ClaudeService;
}

const PDF: TelegramDocument = {
  file_id: 'docABC',
  file_name: 'paper.pdf',
  mime_type: 'application/pdf',
  file_size: 12_345,
};

afterEach(() => {
  setPdfExtractor(async (buf) => ({ text: buf.toString('utf8'), totalPages: 1 }));
});

describe('DocumentHandler', () => {
  it('rejects non-PDF documents', async () => {
    const gateway = makeGateway();
    const chat = makeChat();
    const handler = new DocumentHandler(gateway, chat);

    await handler.handle(
      42,
      { file_id: 'x', mime_type: 'text/plain', file_name: 'note.txt' },
      undefined,
      9001,
    );

    expect(chat.handleTurn).not.toHaveBeenCalled();
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringMatching(/только PDF/),
    );
  });

  it('rejects oversize PDF (Telegram-reported size)', async () => {
    const gateway = makeGateway();
    const chat = makeChat();
    const handler = new DocumentHandler(gateway, chat);

    await handler.handle(
      42,
      { ...PDF, file_size: 21 * 1024 * 1024 },
      undefined,
      9001,
    );

    expect(gateway.getFileBuffer).not.toHaveBeenCalled();
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringMatching(/слишком больш/),
    );
  });

  it('rejects PDFs with >25 pages', async () => {
    setPdfExtractor(async () => ({ text: 'hi', totalPages: 26 }));
    const gateway = makeGateway();
    const chat = makeChat();
    const handler = new DocumentHandler(gateway, chat);

    await handler.handle(42, PDF, undefined, 9001);

    expect(chat.handleTurn).not.toHaveBeenCalled();
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringMatching(/>25 страниц/),
    );
  });

  it('rejects PDFs with >100k extracted tokens', async () => {
    setPdfExtractor(async () => ({ text: 'x'.repeat(500_000), totalPages: 5 }));
    const gateway = makeGateway();
    const chat = makeChat();
    const handler = new DocumentHandler(gateway, chat);

    await handler.handle(42, PDF, undefined, 9001);

    expect(chat.handleTurn).not.toHaveBeenCalled();
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringMatching(/>100k токенов/),
    );
  });

  it('fail-soft when PDF extract throws (encrypted/scanned)', async () => {
    setPdfExtractor(async () => {
      throw new Error('PasswordException');
    });
    const gateway = makeGateway();
    const chat = makeChat();
    const handler = new DocumentHandler(gateway, chat);

    await handler.handle(42, PDF, undefined, 9001);

    expect(gateway.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringMatching(/Не удалось извлечь текст/),
    );
  });

  it('routes extracted text through Claude with document modality', async () => {
    setPdfExtractor(async () => ({
      text: 'ARCA-0011 acceptance test marker',
      totalPages: 2,
    }));
    const gateway = makeGateway();
    const chat = makeChat();
    const handler = new DocumentHandler(gateway, chat);

    await handler.handle(42, PDF, 'Какая фраза-маркер в документе?', 9001);

    const [userId, composed, options] = (chat.handleTurn as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(userId).toBe(9001);
    expect(options.modality).toBe('document');
    expect(composed).toContain('ARCA-0011 acceptance test marker');
    expect(composed).toContain('paper.pdf');
    expect(gateway.sendMessage).toHaveBeenLastCalledWith(42, 'Сводка готова.');
  });
});
