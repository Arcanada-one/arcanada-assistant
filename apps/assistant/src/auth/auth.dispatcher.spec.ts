import { describe, expect, it, vi } from 'vitest';

import { AgentAuthError } from '../aal/exceptions.js';

import { AuthDispatcher } from './auth.dispatcher.js';
import type {
  AuthOutcome,
  AuthRequestSnapshot,
  AuthStrategyName,
  IAuthStrategy,
} from './auth-strategy.interface.js';

function makeStrategy(
  name: AuthStrategyName,
  priority: number,
  outcome: AuthOutcome | null,
): IAuthStrategy {
  return {
    name,
    priority,
    authenticate: vi.fn().mockResolvedValue(outcome),
  };
}

describe('AuthDispatcher', () => {
  it('orders strategies by priority desc on construction', () => {
    const dispatcher = new AuthDispatcher([
      makeStrategy('tailscale', 10, null),
      makeStrategy('auth-arcana-jwt', 100, null),
      makeStrategy('vault-api-key', 50, null),
    ]);
    expect(dispatcher.describe()).toEqual([
      { name: 'auth-arcana-jwt', priority: 100 },
      { name: 'vault-api-key', priority: 50 },
      { name: 'tailscale', priority: 10 },
    ]);
  });

  it('returns the first non-null ok principal (priority order)', async () => {
    const jwt = makeStrategy('auth-arcana-jwt', 100, null);
    const vault = makeStrategy('vault-api-key', 50, {
      ok: true,
      principal: { id: 'svc:assistant', strategy: 'vault-api-key' },
    });
    const tailscale = makeStrategy('tailscale', 10, {
      ok: true,
      principal: { id: 'svc:tailscale-peer', strategy: 'tailscale' },
    });

    const dispatcher = new AuthDispatcher([jwt, vault, tailscale]);
    const principal = await dispatcher.authenticate(emptyReq());
    expect(principal).toEqual({ id: 'svc:assistant', strategy: 'vault-api-key' });
    // tailscale.authenticate must NOT be called because vault produced ok
    expect(tailscale.authenticate).not.toHaveBeenCalled();
  });

  it('returns null when every strategy declines (no header, no tailnet IP)', async () => {
    const jwt = makeStrategy('auth-arcana-jwt', 100, null);
    const vault = makeStrategy('vault-api-key', 50, null);
    const tailscale = makeStrategy('tailscale', 10, null);
    const dispatcher = new AuthDispatcher([jwt, vault, tailscale]);
    const principal = await dispatcher.authenticate(emptyReq());
    expect(principal).toBeNull();
  });

  it('throws AgentAuthError when highest matching strategy rejects (no fallthrough)', async () => {
    const jwt = makeStrategy('auth-arcana-jwt', 100, {
      ok: false,
      reason: 'jwt_expired',
    });
    const vault = makeStrategy('vault-api-key', 50, {
      ok: true,
      principal: { id: 'svc:assistant', strategy: 'vault-api-key' },
    });
    const dispatcher = new AuthDispatcher([jwt, vault]);

    await expect(dispatcher.authenticate(emptyReq())).rejects.toBeInstanceOf(AgentAuthError);
    // vault.authenticate must NOT be called because jwt explicitly rejected
    expect(vault.authenticate).not.toHaveBeenCalled();
  });

  it('forwards request snapshot to every strategy until one applies', async () => {
    const jwt = makeStrategy('auth-arcana-jwt', 100, null);
    const vault = makeStrategy('vault-api-key', 50, null);
    const tailscale = makeStrategy('tailscale', 10, {
      ok: true,
      principal: { id: 'svc:tailscale-peer', strategy: 'tailscale' },
    });
    const dispatcher = new AuthDispatcher([jwt, vault, tailscale]);

    const req: AuthRequestSnapshot = {
      headers: { 'x-correlation-id': 'abc' },
      ip: '100.95.0.1',
    };
    await dispatcher.authenticate(req);
    expect(jwt.authenticate).toHaveBeenCalledWith(req);
    expect(vault.authenticate).toHaveBeenCalledWith(req);
    expect(tailscale.authenticate).toHaveBeenCalledWith(req);
  });

  it('AgentAuthError carries strategy name in detail field for log routing', async () => {
    const jwt = makeStrategy('auth-arcana-jwt', 100, {
      ok: false,
      reason: 'jwt_expired',
    });
    const dispatcher = new AuthDispatcher([jwt]);
    try {
      await dispatcher.authenticate(emptyReq());
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentAuthError);
      const authErr = err as AgentAuthError;
      expect(authErr.kind).toBe('auth');
      expect(authErr.detail).toBe('strategy=auth-arcana-jwt');
      expect(authErr.message).toContain('jwt_expired');
    }
  });
});

function emptyReq(): AuthRequestSnapshot {
  return { headers: {} };
}
