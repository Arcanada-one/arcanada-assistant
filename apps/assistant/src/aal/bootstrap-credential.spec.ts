import { describe, expect, it, vi } from 'vitest';

import {
  BootstrapConfigError,
  BootstrapCredentialRegistry,
  type CredentialProbe,
} from './bootstrap-credential.js';

function probe(
  name: string,
  outcome: Awaited<ReturnType<CredentialProbe['probe']>>,
  opts?: Partial<CredentialProbe>,
): CredentialProbe {
  return {
    name,
    probe: vi.fn().mockResolvedValue(outcome),
    ...opts,
  };
}

describe('BootstrapCredentialRegistry', () => {
  it('runs all registered probes in order', async () => {
    const reg = new BootstrapCredentialRegistry();
    const a = probe('a', { ok: true });
    const b = probe('b', { ok: true });
    reg.register(a);
    reg.register(b);
    const results = await reg.runAll();
    expect(results).toHaveLength(2);
    expect(results[0].outcome).toEqual({ ok: true });
    expect(results[1].outcome).toEqual({ ok: true });
  });

  it('throws BootstrapConfigError on missing_config by default (fail-fast)', async () => {
    const reg = new BootstrapCredentialRegistry();
    reg.register(probe('auth', { ok: false, kind: 'missing_config', detail: 'JWT_SECRET unset' }));
    await expect(reg.runAll()).rejects.toBeInstanceOf(BootstrapConfigError);
  });

  it('does NOT throw on missing_config when requireSuccess=false (opt-out gate)', async () => {
    const reg = new BootstrapCredentialRegistry();
    reg.register(
      probe(
        'optional',
        { ok: false, kind: 'missing_config', detail: 'not configured' },
        { requireSuccess: false },
      ),
    );
    const results = await reg.runAll();
    expect(results[0].outcome).toEqual({
      ok: false,
      kind: 'missing_config',
      detail: 'not configured',
    });
  });

  it('does NOT throw on probe_failed by default (soft-fail)', async () => {
    const reg = new BootstrapCredentialRegistry();
    reg.register(probe('transcriber', { ok: false, kind: 'probe_failed', detail: 'mc 500' }));
    const results = await reg.runAll();
    expect(results[0].outcome).toMatchObject({ ok: false, kind: 'probe_failed' });
  });

  it('DOES throw on probe_failed when requireSuccess=true', async () => {
    const reg = new BootstrapCredentialRegistry();
    reg.register(
      probe(
        'critical',
        { ok: false, kind: 'probe_failed', detail: 'auth-arcana 503' },
        { requireSuccess: true },
      ),
    );
    await expect(reg.runAll()).rejects.toBeInstanceOf(BootstrapConfigError);
  });

  it('absorbs synchronous throws from a probe and treats as probe_failed', async () => {
    const reg = new BootstrapCredentialRegistry();
    reg.register({
      name: 'flaky',
      probe: async () => {
        throw new Error('connection refused');
      },
    });
    const results = await reg.runAll();
    expect(results[0].outcome).toMatchObject({
      ok: false,
      kind: 'probe_failed',
      detail: 'connection refused',
    });
  });

  it('elevates absorbed throw to BootstrapConfigError when requireSuccess=true', async () => {
    const reg = new BootstrapCredentialRegistry();
    reg.register({
      name: 'must-not-throw',
      requireSuccess: true,
      probe: async () => {
        throw new Error('boom');
      },
    });
    await expect(reg.runAll()).rejects.toBeInstanceOf(BootstrapConfigError);
  });
});
