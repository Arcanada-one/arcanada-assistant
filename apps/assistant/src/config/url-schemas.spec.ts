import { describe, expect, it } from 'vitest';

import { internalHttpOrHttpsUrl } from './url-schemas.js';

describe('internalHttpOrHttpsUrl', () => {
  it('accepts any https:// URL', () => {
    expect(internalHttpOrHttpsUrl.safeParse('https://ops.arcanada.one').success).toBe(true);
    expect(internalHttpOrHttpsUrl.safeParse('https://example.com/path').success).toBe(true);
  });

  it('accepts http:// to a docker-internal service name (no dot)', () => {
    expect(internalHttpOrHttpsUrl.safeParse('http://opsbot:3600').success).toBe(true);
    expect(internalHttpOrHttpsUrl.safeParse('http://opsbot').success).toBe(true);
  });

  it('accepts http:// to loopback literals', () => {
    expect(internalHttpOrHttpsUrl.safeParse('http://localhost:3600').success).toBe(true);
    expect(internalHttpOrHttpsUrl.safeParse('http://127.0.0.1:3600').success).toBe(true);
    expect(internalHttpOrHttpsUrl.safeParse('http://[::1]:3600').success).toBe(true);
  });

  // AGENT-0210: Ops Bot moved to another host, so the assistant now reaches its
  // /metrics over the mesh (100.64.0.0/10) rather than a shared docker network.
  it('accepts http:// to a mesh address, including both ends of 100.64.0.0/10', () => {
    expect(internalHttpOrHttpsUrl.safeParse('http://100.108.24.109:3600').success).toBe(true);
    expect(internalHttpOrHttpsUrl.safeParse('http://100.64.0.0:3600').success).toBe(true);
    expect(internalHttpOrHttpsUrl.safeParse('http://100.127.255.255:3600').success).toBe(true);
  });

  // A naive startsWith('100.') would wave these through: 100.0.0.0/10 and
  // 100.128.0.0/9 are ordinary public space, not the CGNAT mesh range.
  it('rejects http:// to 100.x addresses outside the mesh range', () => {
    expect(internalHttpOrHttpsUrl.safeParse('http://100.63.255.255:3600').success).toBe(false);
    expect(internalHttpOrHttpsUrl.safeParse('http://100.128.0.1:3600').success).toBe(false);
    expect(internalHttpOrHttpsUrl.safeParse('http://100.5.5.5:3600').success).toBe(false);
  });

  it('rejects http:// to a public host (dotted hostname, not loopback)', () => {
    expect(internalHttpOrHttpsUrl.safeParse('http://example.com').success).toBe(false);
    expect(internalHttpOrHttpsUrl.safeParse('http://ops.arcanada.one/metrics').success).toBe(false);
    // Not a mesh address despite the leading octet — and not a bare label.
    expect(internalHttpOrHttpsUrl.safeParse('http://100.108.24.109.evil.com').success).toBe(false);
  });

  it('rejects non-URL strings', () => {
    expect(internalHttpOrHttpsUrl.safeParse('not-a-url').success).toBe(false);
    expect(internalHttpOrHttpsUrl.safeParse('').success).toBe(false);
  });

  it('rejects non-http(s) protocols', () => {
    expect(internalHttpOrHttpsUrl.safeParse('ftp://opsbot:3600').success).toBe(false);
    expect(internalHttpOrHttpsUrl.safeParse('file:///etc/passwd').success).toBe(false);
  });
});
