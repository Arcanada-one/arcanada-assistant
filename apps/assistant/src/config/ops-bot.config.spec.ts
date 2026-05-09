import { describe, it, expect, afterEach } from 'vitest';

import opsBotConfig, { OPS_BOT_CONFIG } from './ops-bot.config.js';

const KEYS = ['OPSBOT_BASE_URL', 'OPSBOT_API_KEY'] as const;

describe('opsBot config namespace', () => {
  const original: Record<string, string | undefined> = {};
  for (const k of KEYS) original[k] = process.env[k];

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it('exposes a registerAs token "opsBot"', () => {
    expect(OPS_BOT_CONFIG).toBe('opsBot');
    expect(opsBotConfig.KEY).toBe('CONFIGURATION(opsBot)');
  });

  it('returns OpsBotConfig from process.env', () => {
    process.env.OPSBOT_BASE_URL = 'https://ops.test/';
    process.env.OPSBOT_API_KEY = 'key-123';
    const cfg = opsBotConfig();
    expect(cfg).toEqual({ baseUrl: 'https://ops.test/', apiKey: 'key-123' });
  });

  it('throws when OPSBOT_BASE_URL is non-https', () => {
    process.env.OPSBOT_BASE_URL = 'http://insecure.test/';
    process.env.OPSBOT_API_KEY = 'key-123';
    expect(() => opsBotConfig()).toThrow(/Invalid OpsBot configuration/);
  });

  it('throws when OPSBOT_API_KEY is missing', () => {
    process.env.OPSBOT_BASE_URL = 'https://ops.test/';
    delete process.env.OPSBOT_API_KEY;
    expect(() => opsBotConfig()).toThrow(/OPSBOT_API_KEY/);
  });
});
