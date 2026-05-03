import { describe, expect, it } from 'vitest';
import { configurationSchema, validateConfig } from './configuration.js';

const minimalValid = {
  NODE_ENV: 'development',
  PORT: '3800',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
  REDIS_URL: 'redis://localhost:6379/0',
  TELEGRAM_BOT_TOKEN: 'token',
  TELEGRAM_WEBHOOK_SECRET: 'secret-with-enough-entropy-32chars-min',
  TELEGRAM_WEBHOOK_PATH: '/webhook/telegram',
  AUTH_ARCANA_BASE_URL: 'https://auth.arcanada.one',
  AUTH_ARCANA_JWKS_URL: 'https://auth.arcanada.one/.well-known/jwks.json',
  AUTH_ARCANA_JWT_ISSUER: 'https://auth.arcanada.one',
  AUTH_ARCANA_JWT_AUDIENCE: 'arcanada-assistant',
  MODEL_CONNECTOR_BASE_URL: 'http://connector.arcanada.one:3900',
  MODEL_CONNECTOR_DEFAULT_MODEL: 'anthropic/claude-haiku-4-5',
  SCRUTATOR_BASE_URL: 'http://arcana-db:8310',
  SCRUTATOR_LTM_NAMESPACE: 'assistant-ltm-pavel',
  OPSBOT_BASE_URL: 'https://ops.arcanada.one',
  OPSBOT_API_KEY: 'opsbot-key',
  BRIEFING_TIMEZONE: 'Europe/Istanbul',
  BRIEFING_MORNING_TIME: '08:00',
  BRIEFING_EVENING_TIME: '21:00',
};

describe('configuration', () => {
  it('parses a complete valid env into typed config', () => {
    const cfg = validateConfig(minimalValid);
    expect(cfg.PORT).toBe(3800);
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.AUTH_ARCANA_JWKS_URL).toBe('https://auth.arcanada.one/.well-known/jwks.json');
  });

  it('throws when DATABASE_URL is missing', () => {
    const env = { ...minimalValid } as Record<string, string | undefined>;
    delete env.DATABASE_URL;
    expect(() => validateConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('rejects invalid PORT (non-numeric)', () => {
    expect(() => validateConfig({ ...minimalValid, PORT: 'abc' })).toThrow();
  });

  it('rejects too-short TELEGRAM_WEBHOOK_SECRET', () => {
    expect(() => validateConfig({ ...minimalValid, TELEGRAM_WEBHOOK_SECRET: 'short' })).toThrow(
      /TELEGRAM_WEBHOOK_SECRET/,
    );
  });

  it('rejects malformed BRIEFING_MORNING_TIME', () => {
    expect(() => validateConfig({ ...minimalValid, BRIEFING_MORNING_TIME: '8am' })).toThrow();
  });

  it('rejects non-https AUTH_ARCANA_JWKS_URL', () => {
    expect(() =>
      validateConfig({ ...minimalValid, AUTH_ARCANA_JWKS_URL: 'http://insecure/jwks.json' }),
    ).toThrow();
  });

  it('exports schema for direct introspection', () => {
    expect(configurationSchema).toBeDefined();
  });

  it('NODE_ENV defaults to development if missing', () => {
    const env = { ...minimalValid } as Record<string, string | undefined>;
    delete env.NODE_ENV;
    const cfg = validateConfig(env);
    expect(cfg.NODE_ENV).toBe('development');
  });
});
