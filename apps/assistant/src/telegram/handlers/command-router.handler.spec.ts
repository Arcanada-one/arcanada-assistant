import { describe, it, expect, vi } from 'vitest';

import type { EchoHandler } from '../../webhook/echo.handler.js';

import { CommandRouter } from './command-router.handler.js';
import type { StatusHandler } from './status.handler.js';
import type { AgentsHandler } from './agents.handler.js';
import type { WikiHandler } from './wiki.handler.js';
import type { RememberHandler } from './remember.handler.js';

function build() {
  const echo = { handle: vi.fn() } as unknown as EchoHandler;
  const status = { handle: vi.fn() } as unknown as StatusHandler;
  const agents = { handle: vi.fn() } as unknown as AgentsHandler;
  const wiki = { handle: vi.fn() } as unknown as WikiHandler;
  const remember = { handle: vi.fn() } as unknown as RememberHandler;
  return {
    echo,
    status,
    agents,
    wiki,
    remember,
    router: new CommandRouter(status, agents, wiki, remember, echo),
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

  it('skips updates without message body', async () => {
    const { router, echo } = build();
    await router.handle({ update_id: 5 });
    expect(echo.handle).not.toHaveBeenCalled();
  });

  // ── /wiki ────────────────────────────────────────────────────────────────
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

  // ── /remember ────────────────────────────────────────────────────────────
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
    const { router, echo, remember, wiki } = build();
    await router.handle({
      update_id: 11,
      message: { message_id: 11, chat: { id: 5 }, from: { id: 1 }, text: 'hello world' },
    });
    expect(echo.handle).toHaveBeenCalled();
    expect(remember.handle).not.toHaveBeenCalled();
    expect(wiki.handle).not.toHaveBeenCalled();
  });

  it('passes undefined userId to RememberHandler when from is absent', async () => {
    const { router, remember } = build();
    await router.handle({
      update_id: 12,
      message: { message_id: 12, chat: { id: 5 }, text: '/remember fact' },
    });
    expect(remember.handle).toHaveBeenCalledWith(5, undefined, 'fact');
  });
});
