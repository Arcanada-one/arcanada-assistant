import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { IOpsBotClient } from '@arcanada/core';

import { FatalInterceptor } from './fatal.interceptor.js';

function makeContext(): ExecutionContext {
  return {
    getClass: () => ({ name: 'TestController' }),
    getHandler: () => ({ name: 'testHandler' }),
  } as unknown as ExecutionContext;
}

function makeClient(): IOpsBotClient {
  return {
    emitEvent: vi.fn(async () => ({ event_id: 'x', status: 'accepted' as const })),
    getEcosystemSnapshot: vi.fn(),
    healthReady: vi.fn(),
    isCircuitOpen: vi.fn(() => false),
  } as unknown as IOpsBotClient;
}

describe('FatalInterceptor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T22:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('passes through successful responses without emitting', async () => {
    const client = makeClient();
    const interceptor = new FatalInterceptor(client);
    const next: CallHandler = { handle: () => of({ ok: true }) };
    const result = await firstValueFrom(interceptor.intercept(makeContext(), next));
    expect(result).toEqual({ ok: true });
    expect(client.emitEvent).not.toHaveBeenCalled();
  });

  it('emits fatal event when downstream throws and rethrows the error', async () => {
    const client = makeClient();
    const interceptor = new FatalInterceptor(client);
    const error = new Error('boom');
    const next: CallHandler = { handle: () => throwError(() => error) };
    await expect(firstValueFrom(interceptor.intercept(makeContext(), next))).rejects.toBe(error);
    await Promise.resolve();
    expect(client.emitEvent).toHaveBeenCalledTimes(1);
    const payload = (client.emitEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.category).toBe('fatal');
    expect(payload.severity).toBe('fatal');
    expect(payload.message).toBe('boom');
  });

  it('rate-limits to 10 emits per minute window', async () => {
    const client = makeClient();
    const interceptor = new FatalInterceptor(client);
    const next: CallHandler = { handle: () => throwError(() => new Error('x')) };
    for (let i = 0; i < 12; i += 1) {
      await firstValueFrom(interceptor.intercept(makeContext(), next)).catch(() => undefined);
    }
    await Promise.resolve();
    expect(client.emitEvent).toHaveBeenCalledTimes(10);
  });

  it('allows new emits after window slides forward', async () => {
    const client = makeClient();
    const interceptor = new FatalInterceptor(client);
    const next: CallHandler = { handle: () => throwError(() => new Error('x')) };
    for (let i = 0; i < 10; i += 1) {
      await firstValueFrom(interceptor.intercept(makeContext(), next)).catch(() => undefined);
    }
    vi.advanceTimersByTime(61_000);
    await firstValueFrom(interceptor.intercept(makeContext(), next)).catch(() => undefined);
    await Promise.resolve();
    expect(client.emitEvent).toHaveBeenCalledTimes(11);
  });

  it('does not propagate emitter failures', async () => {
    const client = {
      emitEvent: vi.fn(async () => {
        throw new Error('opsbot down');
      }),
      getEcosystemSnapshot: vi.fn(),
      healthReady: vi.fn(),
      isCircuitOpen: vi.fn(() => false),
    } as unknown as IOpsBotClient;
    const interceptor = new FatalInterceptor(client);
    const original = new Error('original');
    const next: CallHandler = { handle: () => throwError(() => original) };
    await expect(firstValueFrom(interceptor.intercept(makeContext(), next))).rejects.toBe(original);
  });
});
