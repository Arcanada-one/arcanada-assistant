import { describe, expect, it } from 'vitest';

import { TailscaleStrategy, isTailnetIp } from './tailscale.strategy.js';

describe('isTailnetIp (RFC 6598 CGNAT range)', () => {
  it('accepts canonical tailnet addresses', () => {
    expect(isTailnetIp('100.64.0.1')).toBe(true);
    expect(isTailnetIp('100.95.10.42')).toBe(true);
    expect(isTailnetIp('100.127.255.254')).toBe(true);
  });

  it('rejects neighbouring ranges and bogus inputs', () => {
    expect(isTailnetIp('100.63.255.255')).toBe(false);
    expect(isTailnetIp('100.128.0.1')).toBe(false);
    expect(isTailnetIp('10.0.0.1')).toBe(false);
    expect(isTailnetIp('192.168.0.1')).toBe(false);
    expect(isTailnetIp('::1')).toBe(false);
    expect(isTailnetIp('not.an.ip.')).toBe(false);
    expect(isTailnetIp('')).toBe(false);
  });

  it('handles IPv4-mapped IPv6 prefix (::ffff:100.64.0.1)', () => {
    expect(isTailnetIp('::ffff:100.64.0.1')).toBe(true);
    expect(isTailnetIp('::ffff:10.0.0.1')).toBe(false);
  });
});

describe('TailscaleStrategy', () => {
  it('returns null when no IP attached to request', async () => {
    const s = new TailscaleStrategy();
    const out = await s.authenticate({ headers: {} });
    expect(out).toBeNull();
  });

  it('returns null when IP is not in tailnet CGNAT range', async () => {
    const s = new TailscaleStrategy();
    const out = await s.authenticate({ headers: {}, ip: '192.168.1.50' });
    expect(out).toBeNull();
  });

  it('attributes tailnet IPs to svc:tailscale-peer principal', async () => {
    const s = new TailscaleStrategy();
    const out = await s.authenticate({ headers: {}, ip: '100.110.5.42' });
    expect(out).not.toBeNull();
    if (!out || !out.ok) throw new Error('expected ok');
    expect(out.principal.id).toBe('svc:tailscale-peer');
    expect(out.principal.strategy).toBe('tailscale');
    expect(out.principal.claims).toEqual({ ip: '100.110.5.42' });
  });

  it('priority is the lowest (10) so headers override IP', () => {
    expect(new TailscaleStrategy().priority).toBe(10);
  });

  it('does not trust headers like Tailscale-User-Login (proxy-only signal)', async () => {
    const s = new TailscaleStrategy();
    const out = await s.authenticate({
      headers: { 'tailscale-user-login': 'attacker@evil.com' },
      ip: '8.8.8.8',
    });
    expect(out).toBeNull();
  });
});
