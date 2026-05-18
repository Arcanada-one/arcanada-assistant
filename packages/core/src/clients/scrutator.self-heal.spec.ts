import { describe, expect, it, vi } from 'vitest';

import { ScrutatorClient, type ScrutatorSelfHealPayload } from './scrutator.client.js';

/**
 * ARCA-0102 / V-AC-19 regression: when the Scrutator CB transitions to
 * `close` (recovery), the client invokes the injected `selfHealEmit` callback
 * with `{component, level_attempted, fix_applied, outcome, state}` so the
 * consumer can forward to Ops Bot `POST /events`.
 *
 * Tests trigger the close event directly through `client['breaker']` to
 * keep the spec deterministic (CB recovery normally depends on a 60s
 * resetTimeout + a successful probe, which would slow the suite).
 */
describe('ScrutatorClient — self-heal recovery emit (ARCA-0102)', () => {
  it('invokes selfHealEmit with the canonical payload on breaker close', async () => {
    const selfHealEmit = vi.fn();
    const client = new ScrutatorClient({
      baseUrl: 'http://test.local',
      selfHealEmit,
    });
    (client as unknown as { breaker: { emit: (e: string) => void } }).breaker.emit('close');
    await new Promise((r) => setImmediate(r));
    expect(selfHealEmit).toHaveBeenCalledTimes(1);
    const payload = selfHealEmit.mock.calls[0][0] as ScrutatorSelfHealPayload;
    expect(payload).toEqual({
      component: 'scrutator-client',
      level_attempted: 'L4',
      fix_applied: 'cb-recovered',
      outcome: 'ok',
      state: 'close',
    });
  });

  it('does not emit when emitSelfHealOnRecovery=false', async () => {
    const selfHealEmit = vi.fn();
    const client = new ScrutatorClient({
      baseUrl: 'http://test.local',
      selfHealEmit,
      emitSelfHealOnRecovery: false,
    });
    (client as unknown as { breaker: { emit: (e: string) => void } }).breaker.emit('close');
    await new Promise((r) => setImmediate(r));
    expect(selfHealEmit).not.toHaveBeenCalled();
  });

  it('does not throw when selfHealEmit is missing (graceful default)', async () => {
    const client = new ScrutatorClient({ baseUrl: 'http://test.local' });
    expect(() => {
      (client as unknown as { breaker: { emit: (e: string) => void } }).breaker.emit('close');
    }).not.toThrow();
  });

  it('absorbs a sync exception from selfHealEmit (logged, non-fatal)', async () => {
    const warn = vi.fn();
    const selfHealEmit = vi.fn().mockImplementation(() => {
      throw new Error('emit failed');
    });
    const client = new ScrutatorClient({
      baseUrl: 'http://test.local',
      selfHealEmit,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    expect(() => {
      (client as unknown as { breaker: { emit: (e: string) => void } }).breaker.emit('close');
    }).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'emit failed' }),
      'scrutator self_heal recovery emit threw (non-fatal)',
    );
  });

  it('absorbs an async rejection from selfHealEmit (logged, non-fatal)', async () => {
    const warn = vi.fn();
    const selfHealEmit = vi.fn().mockRejectedValue(new Error('async emit failed'));
    const client = new ScrutatorClient({
      baseUrl: 'http://test.local',
      selfHealEmit,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    (client as unknown as { breaker: { emit: (e: string) => void } }).breaker.emit('close');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'async emit failed' }),
      'scrutator self_heal recovery emit failed (non-fatal)',
    );
  });
});
