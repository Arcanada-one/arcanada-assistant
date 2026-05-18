import { Injectable } from '@nestjs/common';

import type { AuthOutcome, AuthRequestSnapshot, IAuthStrategy } from './auth-strategy.interface.js';

/**
 * Tailscale tailnet identity fallback. Pure source-IP gate: if the request
 * arrives from a Tailscale CGNAT (100.64.0.0/10) address — i.e. the same
 * ecosystem mesh — we attribute it to `svc:tailscale-peer`. The orchestrator
 * is expected to further constrain what such a principal can do via
 * `ScopeGuard`.
 *
 * NOTE: this strategy intentionally does NOT trust HTTP headers like
 * `Tailscale-User-Login` (those are only set when Tailscale is the front
 * proxy, which is not our topology). Source IP is the only safe signal.
 */
@Injectable()
export class TailscaleStrategy implements IAuthStrategy {
  readonly name = 'tailscale' as const;
  readonly priority = 10;

  authenticate(req: AuthRequestSnapshot): Promise<AuthOutcome | null> {
    const ip = req.ip;
    if (!ip) return Promise.resolve(null);
    if (!isTailnetIp(ip)) return Promise.resolve(null);
    return Promise.resolve({
      ok: true,
      principal: {
        id: 'svc:tailscale-peer',
        strategy: this.name,
        claims: { ip },
      },
    });
  }
}

export function isTailnetIp(ip: string): boolean {
  // 100.64.0.0/10 — RFC 6598 CGNAT range used by Tailscale.
  const m = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const normalized = m ? m[1] : ip;
  const parts = normalized.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return false;
  const first = octets[0];
  const second = octets[1];
  return first === 100 && second >= 64 && second <= 127;
}
