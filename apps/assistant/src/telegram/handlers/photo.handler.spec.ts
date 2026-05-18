import { describe, expect, it, vi } from 'vitest';

import type { TelegramGateway } from '../../webhook/telegram.gateway.js';
import type { ClaudeService } from '../../chat/chat.service.js';

import { PhotoHandler, type TelegramPhotoSize } from './photo.handler.js';

const pngHeader = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  // 1×1 transparent PNG body padding (sufficient for sniff + base64 path)
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
]);
const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const PHOTOS: TelegramPhotoSize[] = [
  { file_id: 'thumb', file_size: 100, width: 90, height: 60 },
  { file_id: 'med', file_size: 800, width: 320, height: 240 },
  { file_id: 'orig', file_size: 1500, width: 1280, height: 720 },
];

function makeGateway(
  overrides: Partial<TelegramGateway> = {},
  fileBuffer: Buffer = pngHeader,
): TelegramGateway {
  return {
    sendMessage: vi.fn(async () => undefined),
    sendMessageWithKeyboard: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined),
    getFileBuffer: vi.fn(async () => fileBuffer),
    ...overrides,
  };
}

function makeChat(overrides: Partial<ClaudeService> = {}): ClaudeService {
  return {
    handleTurn: vi.fn(async () => ({
      systemPrompt: 'sp',
      userMessage: 'caption',
      reply: 'Изображение распознано.',
      ragApplied: false,
      meta: { model: 'anthropic/claude-sonnet-4', costUsd: 0.001, latencyMs: 250 },
    })),
    ...(overrides as object),
  } as unknown as ClaudeService;
}

describe('PhotoHandler', () => {
  it('downloads the largest photo and routes it through Claude', async () => {
    const gateway = makeGateway();
    const chat = makeChat();
    const handler = new PhotoHandler(gateway, chat);

    await handler.handle(42, PHOTOS, 'Что на фото?', 9001);

    expect(gateway.getFileBuffer).toHaveBeenCalledWith('orig');
    const call = (chat.handleTurn as ReturnType<typeof vi.fn>).mock.calls[0];
    const [userId, content, options] = call;
    expect(userId).toBe(9001);
    expect(options.modality).toBe('photo');
    const blocks = content as Array<{ type: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('text');
    expect(blocks[1].type).toBe('image_url');
    expect(gateway.sendMessage).toHaveBeenLastCalledWith(42, 'Изображение распознано.');
  });

  it('uses a default Russian caption when none is provided', async () => {
    const gateway = makeGateway();
    const chat = makeChat();
    const handler = new PhotoHandler(gateway, chat);

    await handler.handle(42, PHOTOS, undefined, 9001);

    const call = (chat.handleTurn as ReturnType<typeof vi.fn>).mock.calls[0];
    const blocks = call[1] as Array<{ type: string; text?: string }>;
    expect(blocks[0].text).toMatch(/Опиши/);
  });

  it('rejects raw bytes above the 20 MB safety bound', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024 + 1);
    big.set(pngHeader, 0);
    const gateway = makeGateway({}, big);
    const chat = makeChat();
    const handler = new PhotoHandler(gateway, chat);

    await handler.handle(42, PHOTOS, undefined, 9001);

    expect(chat.handleTurn).not.toHaveBeenCalled();
    expect(gateway.sendMessage).toHaveBeenCalledWith(42, expect.stringMatching(/20 МБ/));
  });

  it('sniffs JPEG magic bytes when present', async () => {
    const gateway = makeGateway({}, jpegHeader);
    const chat = makeChat();
    const handler = new PhotoHandler(gateway, chat);

    await handler.handle(42, PHOTOS, 'jpg', 9001);

    const call = (chat.handleTurn as ReturnType<typeof vi.fn>).mock.calls[0];
    const blocks = call[1] as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(blocks[1].image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('warns the user when image mime cannot be recognised', async () => {
    const gateway = makeGateway({}, Buffer.from([0, 1, 2, 3]));
    const chat = makeChat();
    const handler = new PhotoHandler(gateway, chat);

    await handler.handle(42, PHOTOS, undefined, 9001);

    expect(chat.handleTurn).not.toHaveBeenCalled();
    expect(gateway.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringMatching(/Неизвестный формат/),
    );
  });
});
