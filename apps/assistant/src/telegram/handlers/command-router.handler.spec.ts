import { describe, it, expect, vi } from 'vitest';

import type { EchoHandler } from '../../webhook/echo.handler.js';

import { CommandRouter } from './command-router.handler.js';
import type { StatusHandler } from './status.handler.js';
import type { AgentsHandler } from './agents.handler.js';

function build() {
  const echo = { handle: vi.fn() } as unknown as EchoHandler;
  const status = { handle: vi.fn() } as unknown as StatusHandler;
  const agents = { handle: vi.fn() } as unknown as AgentsHandler;
  return {
    echo,
    status,
    agents,
    router: new CommandRouter(status, agents, echo),
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
});
