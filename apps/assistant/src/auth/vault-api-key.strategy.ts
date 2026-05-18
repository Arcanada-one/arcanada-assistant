import { Inject, Injectable } from '@nestjs/common';

import type { AuthOutcome, AuthRequestSnapshot, IAuthStrategy } from './auth-strategy.interface.js';

/**
 * Vault-AppRole-issued API key verifier. The header carries an opaque token
 * `arc_api_*`; the actual Vault lookup is injected so the strategy stays
 * testable (no live Vault in unit specs).
 */
export interface VaultApiKeyVerifier {
  /**
   * Maps a presented key string to a principal id or rejection reason.
   * Implementations are expected to be cheap (cache the Vault response).
   */
  verify(
    key: string,
  ): Promise<
    { ok: true; principal: string; scopes?: readonly string[] } | { ok: false; reason: string }
  >;
}

export const VAULT_API_KEY_VERIFIER = Symbol.for('VAULT_API_KEY_VERIFIER');

const API_KEY_PATTERN = /^arc_api_[A-Za-z0-9_-]{20,}$/;

@Injectable()
export class VaultApiKeyStrategy implements IAuthStrategy {
  readonly name = 'vault-api-key' as const;
  readonly priority = 50;

  constructor(@Inject(VAULT_API_KEY_VERIFIER) private readonly verifier: VaultApiKeyVerifier) {}

  async authenticate(req: AuthRequestSnapshot): Promise<AuthOutcome | null> {
    const raw = req.headers['x-api-key'];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key) return null;
    if (!API_KEY_PATTERN.test(key)) {
      return { ok: false, reason: 'malformed_api_key' };
    }
    const result = await this.verifier.verify(key);
    if (!result.ok) return { ok: false, reason: result.reason };
    return {
      ok: true,
      principal: {
        id: result.principal,
        strategy: this.name,
        ...(result.scopes ? { claims: { scopes: [...result.scopes] } } : {}),
      },
    };
  }
}
