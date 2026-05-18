import { describe, expect, it, vi } from 'vitest';

import { AuthArcanaJwtStrategy, type AuthArcanaJwtVerifier } from './auth-arcana-jwt.strategy.js';

function makeStrategy(opts: { enabled: boolean; verify?: AuthArcanaJwtVerifier['verify'] }): {
  strategy: AuthArcanaJwtStrategy;
  verify: AuthArcanaJwtVerifier['verify'];
} {
  const verify = opts.verify ?? vi.fn();
  const verifier: AuthArcanaJwtVerifier = { verify };
  const strategy = new AuthArcanaJwtStrategy(verifier, { enabled: opts.enabled });
  return { strategy, verify };
}

describe('AuthArcanaJwtStrategy', () => {
  it('returns null when feature flag is OFF, even with valid Bearer header', async () => {
    const verify = vi.fn().mockResolvedValue({ ok: true, principal: 'human:42', claims: {} });
    const { strategy } = makeStrategy({ enabled: false, verify });
    const out = await strategy.authenticate({
      headers: { authorization: 'Bearer eyJhbGc...' },
    });
    expect(out).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns null when feature flag is ON but no Authorization header', async () => {
    const { strategy, verify } = makeStrategy({ enabled: true });
    const out = await strategy.authenticate({ headers: {} });
    expect(out).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects non-Bearer Authorization shapes without calling verifier', async () => {
    const { strategy, verify } = makeStrategy({ enabled: true });
    const out = await strategy.authenticate({
      headers: { authorization: 'Basic abc==' },
    });
    expect(out).toEqual({ ok: false, reason: 'malformed_authorization_header' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects empty Bearer token', async () => {
    const { strategy } = makeStrategy({ enabled: true });
    const out = await strategy.authenticate({
      headers: { authorization: 'Bearer   ' },
    });
    expect(out).toEqual({ ok: false, reason: 'empty_bearer_token' });
  });

  it('forwards verifier success with full claim payload', async () => {
    const verify = vi.fn().mockResolvedValue({
      ok: true,
      principal: 'human:42',
      claims: { sub: '42', email: 'p@example.com', iss: 'https://auth.arcanada.one' },
    });
    const { strategy } = makeStrategy({ enabled: true, verify });
    const out = await strategy.authenticate({
      headers: { authorization: 'Bearer good.token.here' },
    });
    expect(verify).toHaveBeenCalledWith('good.token.here');
    expect(out).toEqual({
      ok: true,
      principal: {
        id: 'human:42',
        strategy: 'auth-arcana-jwt',
        claims: { sub: '42', email: 'p@example.com', iss: 'https://auth.arcanada.one' },
      },
    });
  });

  it('forwards verifier rejection (signature mismatch / expired)', async () => {
    const verify = vi.fn().mockResolvedValue({ ok: false, reason: 'jwt_expired' });
    const { strategy } = makeStrategy({ enabled: true, verify });
    const out = await strategy.authenticate({
      headers: { authorization: 'Bearer expired.token' },
    });
    expect(out).toEqual({ ok: false, reason: 'jwt_expired' });
  });

  it('priority is 100 (highest of all strategies)', () => {
    const { strategy } = makeStrategy({ enabled: false });
    expect(strategy.priority).toBe(100);
  });
});
