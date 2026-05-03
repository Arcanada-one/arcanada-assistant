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
      // eslint-disable-next-line @typescript-eslint/require-await
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
    expect(result.latencyMs).toBeGreaterThanOrEqual(50);
  });
});
