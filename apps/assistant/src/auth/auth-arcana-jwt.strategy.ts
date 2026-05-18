import { Inject, Injectable } from '@nestjs/common';

import type { AuthOutcome, AuthRequestSnapshot, IAuthStrategy } from './auth-strategy.interface.js';

/**
 * Auth Arcana OIDC verifier — pluggable strategy. Disabled by default behind
 * the `MESH_AUTH_ARCANA_JWT=false` feature flag. When the flag flips, this
 * strategy becomes the highest-priority gate (priority 100) and short-
 * circuits the Vault API-key path.
 *
 * The verifier is injected so unit specs can stub JWKS without a live
 * Auth Arcana instance. Implementations are expected to:
 *   1. Resolve JWKS from `AUTH_ARCANA_JWKS_URL` (cached).
 *   2. Validate signature, issuer (`AUTH_ARCANA_JWT_ISSUER`), audience
 *      (`AUTH_ARCANA_JWT_AUDIENCE`), and `exp`.
 *   3. Map verified claims to a principal id, e.g. `svc:assistant` or
 *      `human:<sub>`.
 */
export interface AuthArcanaJwtVerifier {
  verify(
    token: string,
  ): Promise<
    { ok: true; principal: string; claims: Record<string, unknown> } | { ok: false; reason: string }
  >;
}

export const AUTH_ARCANA_JWT_VERIFIER = Symbol.for('AUTH_ARCANA_JWT_VERIFIER');

export interface AuthArcanaJwtStrategyOptions {
  enabled: boolean;
}

export const AUTH_ARCANA_JWT_OPTIONS = Symbol.for('AUTH_ARCANA_JWT_OPTIONS');

@Injectable()
export class AuthArcanaJwtStrategy implements IAuthStrategy {
  readonly name = 'auth-arcana-jwt' as const;
  readonly priority = 100;

  constructor(
    @Inject(AUTH_ARCANA_JWT_VERIFIER) private readonly verifier: AuthArcanaJwtVerifier,
    @Inject(AUTH_ARCANA_JWT_OPTIONS) private readonly options: AuthArcanaJwtStrategyOptions,
  ) {}

  async authenticate(req: AuthRequestSnapshot): Promise<AuthOutcome | null> {
    if (!this.options.enabled) return null;
    const auth = req.headers.authorization;
    const header = Array.isArray(auth) ? auth[0] : auth;
    if (!header) return null;
    const match = header.match(/^Bearer\s+(.+)$/);
    if (!match) return { ok: false, reason: 'malformed_authorization_header' };
    const token = match[1].trim();
    if (!token) return { ok: false, reason: 'empty_bearer_token' };
    const result = await this.verifier.verify(token);
    if (!result.ok) return { ok: false, reason: result.reason };
    return {
      ok: true,
      principal: {
        id: result.principal,
        strategy: this.name,
        claims: result.claims,
      },
    };
  }
}
