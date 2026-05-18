import IoredisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IOpsBotClient } from '@arcanada/core';

import {
  ProactiveDispatcherService,
  TelegramRateLimitError,
  TelegramTransientError,
} from './proactive-dispatcher.service.js';
import { ProactiveMetricsService } from './proactive-metrics.service.js';
import type { IProactiveTelegramSender, TelegramSendOutcome } from './proactive-telegram.sender.js';

function buildOps(): IOpsBotClient {
  return {
    emitEvent: vi.fn().mockResolvedValue({ event_id: 'evt-1', status: 'accepted' }),
    executeCommand: vi.fn(),
    healthReady: vi.fn(),
    isCircuitOpen: vi.fn(),
    getEcosystemSnapshot: vi.fn(),
  } as unknown as IOpsBotClient;
}

function buildSender(outcomes: TelegramSendOutcome[]): IProactiveTelegramSender {
  let i = 0;
  return {
    send: vi.fn().mockImplementation(() => {
      const out = outcomes[i] ?? outcomes[outcomes.length - 1];
      i += 1;
      return Promise.resolve(out);
    }),
  };
}

function makeRedis(): Redis {
  return new (IoredisMock as unknown as new () => Redis)();
}

const baseInput = {
  kind: 'briefing' as const,
  text: '*Брифинг*',
  chatId: 100,
  runDate: '2026-05-18',
};

describe('ProactiveDispatcherService', () => {
  let redis: Redis;
  let metrics: ProactiveMetricsService;
  let ops: IOpsBotClient;

  beforeEach(async () => {
    redis = makeRedis();
    await redis.flushall();
    metrics = new ProactiveMetricsService();
    ops = buildOps();
  });

  it('sends and SETNX-claims on first call (sent)', async () => {
    const sender = buildSender([{ ok: true, messageId: 4271 }]);
    const svc = ProactiveDispatcherService.withDeps({ redis, sender, opsBot: ops, metrics });
    const res = await svc.dispatch(baseInput);
    expect(res.status).toBe('sent');
    expect(res.messageId).toBe(4271);
    expect(await redis.get('proactive:briefing:2026-05-18:sent')).toBe('1');
    expect(metrics.value('briefing', 'sent')).toBe(1);
  });

  it('skips dispatch when idempotency key already present', async () => {
    await redis.set('proactive:briefing:2026-05-18:sent', '1');
    const sender = buildSender([{ ok: true, messageId: 99 }]);
    const svc = ProactiveDispatcherService.withDeps({ redis, sender, opsBot: ops, metrics });
    const res = await svc.dispatch(baseInput);
    expect(res.status).toBe('skipped');
    expect(sender.send).not.toHaveBeenCalled();
    expect(metrics.value('briefing', 'skipped')).toBe(1);
  });

  it('falls back to plain text on 400 "can\'t parse entities"', async () => {
    const sender = buildSender([
      {
        ok: false,
        errorCode: 400,
        description: "Bad Request: can't parse entities: '.' is reserved",
      },
      { ok: true, messageId: 4272 },
    ]);
    const svc = ProactiveDispatcherService.withDeps({ redis, sender, opsBot: ops, metrics });
    const res = await svc.dispatch(baseInput);
    expect(res.status).toBe('sent');
    expect(sender.send).toHaveBeenCalledTimes(2);
    const [, secondArgs] = (sender.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(secondArgs![2]).toBeNull();
  });

  it('throws TelegramRateLimitError on 429 (retryable)', async () => {
    const sender = buildSender([
      { ok: false, errorCode: 429, description: 'Too Many Requests', retryAfter: 12 },
    ]);
    const svc = ProactiveDispatcherService.withDeps({ redis, sender, opsBot: ops, metrics });
    await expect(svc.dispatch(baseInput)).rejects.toBeInstanceOf(TelegramRateLimitError);
    expect(await redis.get('proactive:briefing:2026-05-18:sent')).toBeNull();
    expect(metrics.value('briefing', 'failed')).toBe(1);
  });

  it('throws TelegramTransientError on 5xx (retryable)', async () => {
    const sender = buildSender([{ ok: false, errorCode: 503, description: 'Service Unavailable' }]);
    const svc = ProactiveDispatcherService.withDeps({ redis, sender, opsBot: ops, metrics });
    await expect(svc.dispatch(baseInput)).rejects.toBeInstanceOf(TelegramTransientError);
  });

  it('emits self_heal event after 3 consecutive failures', async () => {
    const sender = buildSender([
      { ok: false, errorCode: 503, description: 'X' },
      { ok: false, errorCode: 503, description: 'X' },
      { ok: false, errorCode: 503, description: 'X' },
    ]);
    const svc = ProactiveDispatcherService.withDeps({ redis, sender, opsBot: ops, metrics });
    await expect(svc.dispatch(baseInput)).rejects.toThrow();
    await expect(svc.dispatch(baseInput)).rejects.toThrow();
    await expect(svc.dispatch(baseInput)).rejects.toThrow();
    expect(ops.emitEvent).toHaveBeenCalledTimes(1);
    const [args] = (ops.emitEvent as ReturnType<typeof vi.fn>).mock.calls;
    expect(args![0].category).toBe('self_heal');
    expect(args![0].message).toMatch(/proactive-dispatcher/);
  });

  it('resets failure counter on successful send', async () => {
    const sender = buildSender([
      { ok: false, errorCode: 503, description: 'X' },
      { ok: false, errorCode: 503, description: 'X' },
      { ok: true, messageId: 1 },
    ]);
    const svc = ProactiveDispatcherService.withDeps({ redis, sender, opsBot: ops, metrics });
    await expect(svc.dispatch(baseInput)).rejects.toThrow();
    await expect(svc.dispatch(baseInput)).rejects.toThrow();
    const res = await svc.dispatch(baseInput);
    expect(res.status).toBe('sent');
    expect(await redis.get('proactive:briefing:consecutive_failures')).toBeNull();
    expect(ops.emitEvent).not.toHaveBeenCalled();
  });
});
