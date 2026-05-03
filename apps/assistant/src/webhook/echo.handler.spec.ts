import { describe, expect, it, vi } from 'vitest';
import { EchoHandler } from './echo.handler.js';

describe('EchoHandler', () => {
  it('replies with scaffold version banner to text message', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const handler = new EchoHandler({ sendMessage: send } as never);
    await handler.handle({
      update_id: 1,
      message: { message_id: 1, chat: { id: 42 }, text: '/start' },
    } as never);
    expect(send).toHaveBeenCalledOnce();
    const [chatId, text] = send.mock.calls[0];
    expect(chatId).toBe(42);
    expect(text).toContain('scaffold');
    expect(text).toContain('0.1.0');
  });

  it('skips updates without a message body (silent)', async () => {
    const send = vi.fn();
    const handler = new EchoHandler({ sendMessage: send } as never);
    await handler.handle({ update_id: 2 } as never);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not throw when sendMessage rejects (fire-and-forget)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Telegram down'));
    const handler = new EchoHandler({ sendMessage: send } as never);
    await expect(
      handler.handle({
        update_id: 3,
        message: { message_id: 7, chat: { id: 5 }, text: 'hi' },
      } as never),
    ).resolves.toBeUndefined();
  });
});
