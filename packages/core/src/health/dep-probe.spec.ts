import { describe, it, expect } from 'vitest';

import { runProbe, pendingIntegration, type DepProbe } from './dep-probe.js';

describe('runProbe', () => {
  it('returns ok with measured latency for healthy probe', async () => {
    const probe: DepProbe = {
      name: 'fake-pg',
      async check() {
        await new Promise((r) => setTimeout(r, 5));
      },
    };
    const result = await runProbe(probe);
    expect(result.name).toBe('fake-pg');
    expect(result.status).toBe('ok');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('returns fail with error message when probe throws', async () => {
    const probe: DepProbe = {
      name: 'fake-redis',
      async check() {
        throw new Error('ECONNREFUSED');
      },
    };
    const result = await runProbe(probe);
    expect(result.name).toBe('fake-redis');
    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('returns fail with stringified non-Error throwable', async () => {
    const probe: DepProbe = {
      name: 'odd',

      async check() {
        throw 'string-thrown';
      },
    };
    const result = await runProbe(probe);
    expect(result.status).toBe('fail');
    expect(result.error).toBe('string-thrown');
  });

  it('pendingIntegration returns sentinel result', () => {
    const result = pendingIntegration('scrutator');
    expect(result.name).toBe('scrutator');
    expect(result.status).toBe('pending-integration');
    expect(result.latencyMs).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('returns fail with timeout message when probe exceeds budget', async () => {
    const probe: DepProbe = {
      name: 'slow-svc',
      async check() {
        await new Promise((r) => setTimeout(r, 200));
      },
    };
    const result = await runProbe(probe, { timeoutMs: 50 });
    expect(result.status).toBe('fail');
    expect(result.error).toMatch(/timeout/i);
    // Deliberately NOT `toBeGreaterThanOrEqual(50)`. That assertion failed in
    // CI on a healthy implementation with "expected 49 to be greater than or
    // equal to 50": setTimeout fires off the system timer while the latency is
    // measured with performance.now() and then Math.round()ed, so a genuine
    // ~49.5ms wait rounds DOWN and the timeout looks early by a millisecond it
    // never actually was. The property under test is that the probe was cut
    // short at roughly the budget rather than running to the 200ms the check
    // sleeps for — so assert both sides of a band, which still fails if the
    // timeout does not fire (latency would be ~200) or fires far too early.
    expect(result.latencyMs).toBeGreaterThanOrEqual(40);
    expect(result.latencyMs).toBeLessThan(150);
  });
});
