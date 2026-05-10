import { describe, it, expect, afterEach } from 'vitest';

import scrutatorConfig, { SCRUTATOR_CONFIG } from './scrutator.config.js';

const KEYS = [
  'SCRUTATOR_BASE_URL',
  'SCRUTATOR_LTM_NAMESPACE',
  'ECOSYSTEM_SCRUTATOR_INTEGRATION',
] as const;

describe('scrutator config namespace', () => {
  const original: Record<string, string | undefined> = {};
  for (const k of KEYS) original[k] = process.env[k];

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it('exposes a registerAs token "scrutator"', () => {
    expect(SCRUTATOR_CONFIG).toBe('scrutator');
    expect(scrutatorConfig.KEY).toBe('CONFIGURATION(scrutator)');
  });

  it('returns ScrutatorConfig from process.env (https prod)', () => {
    process.env.SCRUTATOR_BASE_URL = 'https://scrutator.arcanada.one';
    process.env.SCRUTATOR_LTM_NAMESPACE = 'assistant';
    delete process.env.ECOSYSTEM_SCRUTATOR_INTEGRATION;
    const cfg = scrutatorConfig();
    expect(cfg).toEqual({
      baseUrl: 'https://scrutator.arcanada.one',
      ltmNamespace: 'assistant',
      integrationEnabled: true,
    });
  });

  it('accepts http://localhost for dev', () => {
    process.env.SCRUTATOR_BASE_URL = 'http://localhost:8310';
    process.env.SCRUTATOR_LTM_NAMESPACE = 'assistant';
    expect(() => scrutatorConfig()).not.toThrow();
    expect(scrutatorConfig().baseUrl).toBe('http://localhost:8310');
  });

  it('accepts http://arcana-db (Tailscale-internal hostname) for dev/prod', () => {
    process.env.SCRUTATOR_BASE_URL = 'http://arcana-db:8310';
    process.env.SCRUTATOR_LTM_NAMESPACE = 'assistant';
    expect(() => scrutatorConfig()).not.toThrow();
  });

  it('throws when SCRUTATOR_BASE_URL is missing', () => {
    delete process.env.SCRUTATOR_BASE_URL;
    process.env.SCRUTATOR_LTM_NAMESPACE = 'assistant';
    expect(() => scrutatorConfig()).toThrow(/SCRUTATOR_BASE_URL/);
  });

  it('throws when SCRUTATOR_BASE_URL is not a URL', () => {
    process.env.SCRUTATOR_BASE_URL = 'not-a-url';
    process.env.SCRUTATOR_LTM_NAMESPACE = 'assistant';
    expect(() => scrutatorConfig()).toThrow(/Invalid Scrutator configuration/);
  });

  it('throws when SCRUTATOR_LTM_NAMESPACE is missing', () => {
    process.env.SCRUTATOR_BASE_URL = 'http://localhost:8310';
    delete process.env.SCRUTATOR_LTM_NAMESPACE;
    expect(() => scrutatorConfig()).toThrow(/SCRUTATOR_LTM_NAMESPACE/);
  });

  it('integrationEnabled defaults to true when env unset', () => {
    process.env.SCRUTATOR_BASE_URL = 'http://localhost:8310';
    process.env.SCRUTATOR_LTM_NAMESPACE = 'assistant';
    delete process.env.ECOSYSTEM_SCRUTATOR_INTEGRATION;
    expect(scrutatorConfig().integrationEnabled).toBe(true);
  });

  it('integrationEnabled=false when ECOSYSTEM_SCRUTATOR_INTEGRATION=false', () => {
    process.env.SCRUTATOR_BASE_URL = 'http://localhost:8310';
    process.env.SCRUTATOR_LTM_NAMESPACE = 'assistant';
    process.env.ECOSYSTEM_SCRUTATOR_INTEGRATION = 'false';
    expect(scrutatorConfig().integrationEnabled).toBe(false);
  });

  it('does NOT expose any apiKey field (Tailscale-only network policy)', () => {
    process.env.SCRUTATOR_BASE_URL = 'http://localhost:8310';
    process.env.SCRUTATOR_LTM_NAMESPACE = 'assistant';
    const cfg = scrutatorConfig();
    expect(cfg).not.toHaveProperty('apiKey');
  });
});
