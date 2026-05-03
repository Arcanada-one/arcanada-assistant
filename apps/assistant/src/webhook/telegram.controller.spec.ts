import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { TelegramController } from './telegram.controller.js';

const SECRET = 'a'.repeat(32);

function makeController() {
  const handler = { handle: vi.fn().mockResolvedValue(undefined) };
  const config = {
    get: vi.fn((key: string) =>
      key === 'TELEGRAM_WEBHOOK_SECRET' ? SECRET : undefined,
    ),
  };
  const controller = new TelegramController(handler as never, config as never);
  return { controller, handler, config };
}

describe('TelegramController', () => {
  it('returns 200 ack when secret_token matches', async () => {
    const { controller, handler } = makeController();
    const result = await controller.handle(
      { update_id: 1, message: { message_id: 1, chat: { id: 1 }, text: 'hi' } } as never,
      SECRET,
    );
    expect(result).toEqual({ ok: true });
    // Fire-and-forget: handler is invoked but we don't await its full chain.
    await new Promise((r) => setImmediate(r));
    expect(handler.handle).toHaveBeenCalledOnce();
  });

  it('throws Unauthorized when secret header is missing', async () => {
    const { controller } = makeController();
    await expect(
      controller.handle({ update_id: 2 } as never, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws Unauthorized when secret_token mismatches', async () => {
    const { controller } = makeController();
    await expect(
      controller.handle({ update_id: 3 } as never, 'wrong-secret'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not invoke handler on bad secret', async () => {
    const { controller, handler } = makeController();
    await expect(
      controller.handle({ update_id: 4 } as never, 'nope'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(handler.handle).not.toHaveBeenCalled();
  });
});
