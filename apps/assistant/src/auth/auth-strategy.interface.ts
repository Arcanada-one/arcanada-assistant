/**
 * ARCA-0009 M7 — hybrid inter-agent auth (V-AC-6).
 *
 * Three pluggable strategies are tried in priority order on every inbound
 * mesh request. The first strategy that *can apply* (returns a non-null
 * result) wins; downstream strategies are skipped. A non-matching strategy
 * returns `null` so the dispatcher moves on. A matching strategy that fails
 * verification returns `{ ok: false, reason }` and the dispatcher short-
 * circuits with 401 — it does NOT fall through to a lower-priority strategy.
 *
 * Priority floor (header > network):
 *   - 100: AuthArcanaJwt   (Authorization: Bearer <jwt>)
 *   -  50: VaultApiKey     (x-api-key: arc_api_*)
 *   -  10: Tailscale       (source IP in tailnet CGNAT range)
 */

export type AuthStrategyName = 'auth-arcana-jwt' | 'vault-api-key' | 'tailscale';

export interface AuthPrincipal {
  /** Stable identifier suitable for `ScopeGuard` lookup, e.g. `svc:assistant`. */
  readonly id: string;
  readonly strategy: AuthStrategyName;
  readonly claims?: Record<string, unknown>;
}

export interface AuthRequestSnapshot {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip?: string;
}

export type AuthOutcome =
  | { ok: true; principal: AuthPrincipal }
  | { ok: false; reason: string };

export interface IAuthStrategy {
  readonly name: AuthStrategyName;
  readonly priority: number;
  /**
   * `null` ⇒ strategy does not apply to this request (no matching header /
   * IP shape); dispatcher continues with the next strategy.
   *
   * `{ ok: true, ... }` ⇒ strategy validated the request; dispatcher stops.
   *
   * `{ ok: false, reason }` ⇒ strategy *does* apply but verification failed
   * (e.g. JWT signature mismatch); dispatcher stops with 401 and does NOT
   * try lower-priority strategies. Falling back would let an attacker
   * forge a JWT and ride on Tailscale identity.
   */
  authenticate(req: AuthRequestSnapshot): Promise<AuthOutcome | null>;
}

export const AUTH_STRATEGY = Symbol.for('AUTH_STRATEGY');
