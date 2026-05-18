import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthDispatcher } from './auth.dispatcher.js';
import type { IAuthStrategy } from './auth-strategy.interface.js';
import { registerAuthPreflight } from './auth.preflight.js';
import { TailscaleStrategy } from './tailscale.strategy.js';
import { VaultApiKeyStrategy, type VaultApiKeyVerifier } from './vault-api-key.strategy.js';
import { AuthArcanaJwtStrategy, type AuthArcanaJwtVerifier } from './auth-arcana-jwt.strategy.js';

function vaultVerifier(expected: string): VaultApiKeyVerifier {
  return {
    verify: async (key) =>
      key === expected
        ? { ok: true, principal: 'svc:assistant' }
        : { ok: false, reason: 'key_mismatch' },
  };
}

function jwtVerifier(
  fn: (token: string) => ReturnType<AuthArcanaJwtVerifier['verify']>,
): AuthArcanaJwtVerifier {
  return { verify: fn };
}

async function makeApp(strategies: IAuthStrategy[]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const dispatcher = new AuthDispatcher(strategies);
  registerAuthPreflight(app, dispatcher);
  app.get('/agents', async (req) => ({ principal: req.authPrincipal?.id }));
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/webhook/telegram', async () => ({ accepted: true }));
  await app.ready();
  return app;
}

describe('registerAuthPreflight (Fastify hook integration)', () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    app = undefined;
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it('lets /health pass without auth (public prefix)', async () => {
    app = await makeApp([new TailscaleStrategy()]);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('lets /webhook/telegram pass without auth', async () => {
    app = await makeApp([new TailscaleStrategy()]);
    const res = await app.inject({ method: 'POST', url: '/webhook/telegram', payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it('rejects with 401 when no credentials present and no tailnet IP', async () => {
    app = await makeApp([new TailscaleStrategy()]);
    const res = await app.inject({ method: 'GET', url: '/agents' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ statusCode: 401, error: 'Unauthorized' });
  });

  it('accepts via x-api-key (Vault) and labels response with x-auth-strategy', async () => {
    const vault = new VaultApiKeyStrategy(vaultVerifier('arc_api_abcdefghijklmnopqrstuv'));
    app = await makeApp([new TailscaleStrategy(), vault]);
    const res = await app.inject({
      method: 'GET',
      url: '/agents',
      headers: { 'x-api-key': 'arc_api_abcdefghijklmnopqrstuv' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ principal: 'svc:assistant' });
    expect(res.headers['x-auth-strategy']).toBe('vault-api-key');
  });

  it('JWT (when flag on) takes priority over x-api-key', async () => {
    const jwt = new AuthArcanaJwtStrategy(
      jwtVerifier(async () => ({
        ok: true,
        principal: 'human:42',
        claims: { sub: '42' },
      })),
      { enabled: true },
    );
    const vault = new VaultApiKeyStrategy(vaultVerifier('arc_api_abcdefghijklmnopqrstuv'));
    app = await makeApp([new TailscaleStrategy(), vault, jwt]);
    const res = await app.inject({
      method: 'GET',
      url: '/agents',
      headers: {
        authorization: 'Bearer valid.jwt.token',
        'x-api-key': 'arc_api_abcdefghijklmnopqrstuv',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ principal: 'human:42' });
    expect(res.headers['x-auth-strategy']).toBe('auth-arcana-jwt');
  });

  it('when JWT flag is OFF, x-api-key wins even if Authorization is present', async () => {
    const jwt = new AuthArcanaJwtStrategy(
      jwtVerifier(async () => ({ ok: true, principal: 'human:42', claims: {} })),
      { enabled: false },
    );
    const vault = new VaultApiKeyStrategy(vaultVerifier('arc_api_abcdefghijklmnopqrstuv'));
    app = await makeApp([new TailscaleStrategy(), vault, jwt]);
    const res = await app.inject({
      method: 'GET',
      url: '/agents',
      headers: {
        authorization: 'Bearer would.be.valid',
        'x-api-key': 'arc_api_abcdefghijklmnopqrstuv',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ principal: 'svc:assistant' });
    expect(res.headers['x-auth-strategy']).toBe('vault-api-key');
  });

  it('rejected JWT does NOT fall through to lower-priority strategy', async () => {
    const jwt = new AuthArcanaJwtStrategy(
      jwtVerifier(async () => ({ ok: false, reason: 'jwt_expired' })),
      { enabled: true },
    );
    const vault = new VaultApiKeyStrategy(vaultVerifier('arc_api_abcdefghijklmnopqrstuv'));
    app = await makeApp([new TailscaleStrategy(), vault, jwt]);
    const res = await app.inject({
      method: 'GET',
      url: '/agents',
      headers: {
        authorization: 'Bearer expired.jwt',
        'x-api-key': 'arc_api_abcdefghijklmnopqrstuv',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toContain('jwt_expired');
  });
});
