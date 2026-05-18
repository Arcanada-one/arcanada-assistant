import { Inject, Injectable, Logger } from '@nestjs/common';

import { AgentAuthError } from '../aal/exceptions.js';

import {
  AUTH_STRATEGY,
  type AuthOutcome,
  type AuthPrincipal,
  type AuthRequestSnapshot,
  type IAuthStrategy,
} from './auth-strategy.interface.js';

/**
 * Header-priority dispatcher (V-AC-6). Sorts strategies once at construction
 * and tries each on every inbound mesh request:
 *
 *   1. AuthArcanaJwt (when feature-flagged on)
 *   2. VaultApiKey
 *   3. Tailscale (fallback)
 *
 * `authenticate` resolves the first non-null strategy outcome:
 *   - `null` ⇒ try next strategy
 *   - `{ ok: true, principal }` ⇒ return principal
 *   - `{ ok: false, reason }` ⇒ throw AgentAuthError (no fallthrough — see
 *     IAuthStrategy comment)
 *
 * Returns `null` only when every strategy declines (no matching header, no
 * tailnet IP). The middleware can then decide whether to reject as 401 or
 * pass-through (e.g. for `/health` which is unauthenticated).
 */
@Injectable()
export class AuthDispatcher {
  private readonly logger = new Logger(AuthDispatcher.name);
  private readonly strategies: ReadonlyArray<IAuthStrategy>;

  constructor(@Inject(AUTH_STRATEGY) strategies: IAuthStrategy[]) {
    this.strategies = [...strategies].sort((a, b) => b.priority - a.priority);
    this.logger.log(
      `auth dispatcher initialised — ${this.strategies.length} strategies, order: ${this.strategies
        .map((s) => `${s.name}(${s.priority})`)
        .join(' > ')}`,
    );
  }

  describe(): ReadonlyArray<{ name: string; priority: number }> {
    return this.strategies.map((s) => ({ name: s.name, priority: s.priority }));
  }

  async authenticate(req: AuthRequestSnapshot): Promise<AuthPrincipal | null> {
    for (const strategy of this.strategies) {
      const outcome: AuthOutcome | null = await strategy.authenticate(req);
      if (outcome === null) continue;
      if (!outcome.ok) {
        this.logger.warn(
          { strategy: strategy.name, reason: outcome.reason },
          'auth strategy rejected request',
        );
        throw new AgentAuthError(`auth rejected: ${outcome.reason}`, {
          detail: `strategy=${strategy.name}`,
        });
      }
      this.logger.debug?.(
        { strategy: strategy.name, principal: outcome.principal.id },
        'auth strategy accepted request',
      );
      return outcome.principal;
    }
    return null;
  }
}
