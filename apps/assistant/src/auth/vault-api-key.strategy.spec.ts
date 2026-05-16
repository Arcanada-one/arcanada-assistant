import { describe, expect, it, vi } from 'vitest';

import {
  VaultApiKeyStrategy,
  type VaultApiKeyVerifier,
} from './vault-api-key.strategy.js';

function makeStrategy(verifier: VaultApiKeyVerifier): VaultApiKeyStrategy {
  return new VaultApiKeyStrategy(verifier);
}

describe('VaultApiKeyStrategy', () => {
  it('returns null when no x-api-key header is present', async () => {
    const verifier = { verify: vi.fn() };
    const s = makeStrategy(verifier);
    const out = await s.authenticate({ headers: {} });
    expect(out).toBeNull();
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('rejects malformed keys without calling Vault (regex gate)', async () => {
    const verifier = { verify: vi.fn() };
    const s = makeStrategy(verifier);
    const out = await s.authenticate({
      headers: { 'x-api-key': 'short' },
    });
    expect(out).toEqual({ ok: false, reason: 'malformed_api_key' });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('rejects keys without the arc_api_ prefix', async () => {
    const verifier = { verify: vi.fn() };
    const s = makeStrategy(verifier);
    const out = await s.authenticate({
      headers: { 'x-api-key': 'bearer_abcdefghijklmnopqrstuv' },
    });
    expect(out).toEqual({ ok: false, reason: 'malformed_api_key' });
  });

  it('forwards verifier success to outcome with principal + strategy + claims', async () => {
    const verifier: VaultApiKeyVerifier = {
      verify: vi.fn().mockResolvedValue({
        ok: true,
        principal: 'svc:assistant',
        scopes: ['transcriber:invoke', 'munera:write'],
      }),
    };
    const s = makeStrategy(verifier);
    const out = await s.authenticate({
      headers: { 'x-api-key': 'arc_api_abcdefghijklmnopqrstuv' },
    });
    expect(out).toEqual({
      ok: true,
      principal: {
        id: 'svc:assistant',
        strategy: 'vault-api-key',
        claims: { scopes: ['transcriber:invoke', 'munera:write'] },
      },
    });
  });

  it('forwards verifier rejection to outcome with reason', async () => {
    const verifier: VaultApiKeyVerifier = {
      verify: vi.fn().mockResolvedValue({ ok: false, reason: 'revoked' }),
    };
    const s = makeStrategy(verifier);
    const out = await s.authenticate({
      headers: { 'x-api-key': 'arc_api_zzzzzzzzzzzzzzzzzzzzzz' },
    });
    expect(out).toEqual({ ok: false, reason: 'revoked' });
  });

  it('handles array-shaped headers by taking the first value', async () => {
    const verifier: VaultApiKeyVerifier = {
      verify: vi.fn().mockResolvedValue({ ok: true, principal: 'svc:assistant' }),
    };
    const s = makeStrategy(verifier);
    const out = await s.authenticate({
      headers: { 'x-api-key': ['arc_api_abcdefghijklmnopqrstuv', 'arc_api_other'] },
    });
    expect(verifier.verify).toHaveBeenCalledWith('arc_api_abcdefghijklmnopqrstuv');
    expect(out?.ok).toBe(true);
  });

  it('priority is 50 (above tailscale, below jwt)', () => {
    expect(makeStrategy({ verify: vi.fn() }).priority).toBe(50);
  });
});
