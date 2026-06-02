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

  it('rejects http:// to a public host (dotted hostname, not loopback)', () => {
    expect(internalHttpOrHttpsUrl.safeParse('http://example.com').success).toBe(false);
    expect(internalHttpOrHttpsUrl.safeParse('http://ops.arcanada.one/metrics').success).toBe(false);
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
