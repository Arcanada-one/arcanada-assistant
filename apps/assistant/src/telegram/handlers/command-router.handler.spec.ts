import { describe, it, expect, vi } from 'vitest';

import type { EchoHandler } from '../../webhook/echo.handler.js';

import { CommandRouter } from './command-router.handler.js';
import type { StatusHandler } from './status.handler.js';
import type { AgentsHandler } from './agents.handler.js';
import type { WikiHandler } from './wiki.handler.js';
import type { RememberHandler } from './remember.handler.js';
import type { VoiceHandler } from './voice.handler.js';
import type { TaskHandler } from './task.handler.js';
import type { ApprovalCallbackHandler } from './approval-callback.handler.js';

function build() {
  const echo = { handle: vi.fn() } as unknown as EchoHandler;
  const status = { handle: vi.fn() } as unknown as StatusHandler;
  const agents = { handle: vi.fn() } as unknown as AgentsHandler;
  const wiki = { handle: vi.fn() } as unknown as WikiHandler;
  const remember = { handle: vi.fn() } as unknown as RememberHandler;
  const voice = { handle: vi.fn() } as unknown as VoiceHandler;
  const task = { handle: vi.fn() } as unknown as TaskHandler;
  const approvalCallback = { handle: vi.fn() } as unknown as ApprovalCallbackHandler;
  return {
    echo,
    status,
    agents,
    wiki,
    remember,
    voice,
    task,
    approvalCallback,
    router: new CommandRouter(
      status,
      agents,
      wiki,
      remember,
      echo,
      voice,
      task,
      approvalCallback,
    ),
  };
}

describe('CommandRouter', () => {
  it('dispatches /status to StatusHandler', async () => {
    const { router, status } = build();
    await router.handle({
      update_id: 1,
      message: { message_id: 1, chat: { id: 5 }, text: '/status' },
    });
    expect(status.handle).toHaveBeenCalledWith(5);
  });

  it('dispatches /agents to AgentsHandler', async () => {
    const { router, agents } = build();
    await router.handle({
      update_id: 2,
      message: { message_id: 2, chat: { id: 5 }, text: '/agents extra' },
    });
    expect(agents.handle).toHaveBeenCalledWith(5);
  });

  it('falls back to EchoHandler for unknown text', async () => {
    const { router, echo } = build();
    const update = {
      update_id: 3,
      message: { message_id: 3, chat: { id: 5 }, text: 'hello' },
    };
    await router.handle(update);
    expect(echo.handle).toHaveBeenCalledWith(update);
  });

  it('routes /status@bot variant to StatusHandler', async () => {
    const { router, status } = build();
    await router.handle({
      update_id: 4,
      message: { message_id: 4, chat: { id: 7 }, text: '/status@arcanada_bot' },
    });
    expect(status.handle).toHaveBeenCalledWith(7);
  });

  it('skips updates without message body and no callback_query', async () => {
    const { router, echo, approvalCallback } = build();
    await router.handle({ update_id: 5 });
    expect(echo.handle).not.toHaveBeenCalled();
    expect(approvalCallback.handle).not.toHaveBeenCalled();
  });

  it('dispatches /wiki <query> to WikiHandler with extracted query', async () => {
    const { router, wiki } = build();
    await router.handle({
      update_id: 6,
      message: { message_id: 6, chat: { id: 5 }, text: '/wiki   Datarim framework' },
    });
    expect(wiki.handle).toHaveBeenCalledWith(5, 'Datarim framework');
  });

  it('dispatches bare /wiki with empty query (handler validates)', async () => {
    const { router, wiki } = build();
    await router.handle({
      update_id: 7,
      message: { message_id: 7, chat: { id: 5 }, text: '/wiki' },
    });
    expect(wiki.handle).toHaveBeenCalledWith(5, '');
  });

  it('dispatches /remember <text> to RememberHandler with userId', async () => {
    const { router, remember } = build();
    await router.handle({
      update_id: 8,
      message: {
        message_id: 8,
        chat: { id: 5 },
        from: { id: 14128108 },
        text: '/remember arcana-prod IP 65.108.236.39',
      },
    });
    expect(remember.handle).toHaveBeenCalledWith(5, 14128108, 'arcana-prod IP 65.108.236.39');
  });

  it('routes natural-language «запомни, что …» to RememberHandler', async () => {
    const { router, remember } = build();
    await router.handle({
      update_id: 9,
      message: {
        message_id: 9,
        chat: { id: 5 },
        from: { id: 1 },
        text: 'Запомни, что Vault primary живёт на arcana-db:8200',
      },
    });
    expect(remember.handle).toHaveBeenCalledWith(5, 1, 'Vault primary живёт на arcana-db:8200');
  });

  it('routes natural-language «запомни что …» (no comma) to RememberHandler', async () => {
    const { router, remember } = build();
    await router.handle({
      update_id: 10,
      message: {
        message_id: 10,
        chat: { id: 5 },
        from: { id: 1 },
        text: 'запомни что arcana-prod IP 65.108.236.39',
      },
    });
    expect(remember.handle).toHaveBeenCalledWith(5, 1, 'arcana-prod IP 65.108.236.39');
  });

  it('falls back to EchoHandler if message lacks /command prefix and NL trigger', async () => {
    const { router, echo, remember, wiki, task } = build();
    await router.handle({
      update_id: 11,
      message: { message_id: 11, chat: { id: 5 }, from: { id: 1 }, text: 'hello world' },
    });
    expect(echo.handle).toHaveBeenCalled();
    expect(remember.handle).not.toHaveBeenCalled();
    expect(wiki.handle).not.toHaveBeenCalled();
    expect(task.handle).not.toHaveBeenCalled();
  });

  it('passes undefined userId to RememberHandler when from is absent', async () => {
    const { router, remember } = build();
    await router.handle({
      update_id: 12,
      message: { message_id: 12, chat: { id: 5 }, text: '/remember fact' },
    });
    expect(remember.handle).toHaveBeenCalledWith(5, undefined, 'fact');
  });

  // ── ARCA-0009 session 4: voice / task / callback_query ───────────────────

  it('routes message.voice to VoiceHandler', async () => {
    const { router, voice } = build();
    const v = { file_id: 'AwACAg', mime_type: 'audio/ogg', duration: 3 };
    await router.handle({
      update_id: 13,
      message: { message_id: 13, chat: { id: 5 }, voice: v },
    });
    expect(voice.handle).toHaveBeenCalledWith(5, v);
  });

  it('dispatches /task <title> to TaskHandler', async () => {
    const { router, task } = build();
    await router.handle({
      update_id: 14,
      message: { message_id: 14, chat: { id: 5 }, text: '/task Купить хлеб' },
    });
    expect(task.handle).toHaveBeenCalledWith(5, 'Купить хлеб');
  });

  it('routes natural-language «создай задачу …» to TaskHandler', async () => {
    const { router, task } = build();
    await router.handle({
      update_id: 15,
      message: {
        message_id: 15,
        chat: { id: 5 },
        from: { id: 1 },
        text: 'Создай задачу Купить хлеб',
      },
    });
    expect(task.handle).toHaveBeenCalledWith(5, 'Купить хлеб');
  });

  it('routes callback_query to ApprovalCallbackHandler', async () => {
    const { router, approvalCallback } = build();
    const cb = {
      id: 'cbq-1',
      from: { id: 1 },
      data: 'apr:v1:a:01941d7e-3b22-7c11-9f56-d4e3a8b9c012',
      message: { chat: { id: 5 }, message_id: 1 },
    };
    await router.handle({ update_id: 16, callback_query: cb });
    expect(approvalCallback.handle).toHaveBeenCalledWith(cb);
  });

  it('callback_query takes precedence over message in the same update', async () => {
    const { router, approvalCallback, voice } = build();
    await router.handle({
      update_id: 17,
      message: {
        message_id: 17,
        chat: { id: 5 },
        voice: { file_id: 'x', duration: 1 },
      },
      callback_query: {
        id: 'cbq-2',
        from: { id: 1 },
        data: 'apr:v1:r:01941d7e-3b22-7c11-9f56-d4e3a8b9c012',
        message: { chat: { id: 5 }, message_id: 17 },
      },
    });
    expect(approvalCallback.handle).toHaveBeenCalledOnce();
    expect(voice.handle).not.toHaveBeenCalled();
  });
});
