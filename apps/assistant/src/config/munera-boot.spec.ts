/**
 * A2-313 — does the process come up with THIS environment?
 *
 * `ConfigModule.forRoot` (app.module.ts) runs exactly two things over the
 * environment before any module is built: `validate` → `validateConfig`, then
 * each `load` factory, `muneraConfig` among them. Either one throwing is a
 * container that does not start. This spec runs both, over environments taken
 * from what was deployed, not invented:
 *
 *   - `PROD_2026_09_25` — `docker inspect arcanada-assistant-assistant-1` on
 *     arcana-prd, 2026-09-25T08:13Z: `MUNERA_BASE_URL=https://muneral.com`,
 *     `MUNERA_API_TOKEN` = the 8 bytes `changeme` (compose default filling an
 *     empty `.env` value). That container was `Up 37 hours (healthy)` and
 *     `/health` answered `munera: ok`. It must not boot.
 *   - `KEY_FILE_COMPOSE` — the A2-281 compose: `MUNERAL_AGENT_KEY_FILE` set,
 *     `MUNERA_API_TOKEN` not passed at all. It must boot — before this change
 *     `validateConfig` still demanded `MUNERA_API_TOKEN`, so that compose would
 *     have crash-looped on its first deploy.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { validateConfig } from './configuration.js';
import muneraConfig from './munera.config.js';

const BASE = {
  NODE_ENV: 'development',
  PORT: '3800',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
  REDIS_URL: 'redis://localhost:6379/0',
  TELEGRAM_BOT_TOKEN: 'token',
  // A placeholder of the required length, not a value: the schema only checks ≥32 chars.
  TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(32),
  AUTH_ARCANA_BASE_URL: 'https://auth.arcanada.one',
  AUTH_ARCANA_JWKS_URL: 'https://auth.arcanada.one/.well-known/jwks.json',
  AUTH_ARCANA_JWT_ISSUER: 'https://auth.arcanada.one',
  AUTH_ARCANA_JWT_AUDIENCE: 'arcanada-assistant',
  MODEL_CONNECTOR_BASE_URL: 'http://connector.arcanada.one:3900',
  MODEL_CONNECTOR_DEFAULT_MODEL: 'anthropic/claude-haiku-4-5',
  MODEL_CONNECTOR_API_KEY: 'mc-test-key',
  SCRUTATOR_BASE_URL: 'http://arcana-db:8310',
  SCRUTATOR_LTM_NAMESPACE: 'assistant-ltm-pavel',
  OPSBOT_BASE_URL: 'https://ops.arcanada.one',
  OPSBOT_API_KEY: 'opsbot-key',
};

const dir = mkdtempSync(join(tmpdir(), 'a2-313-'));
const keyFile = join(dir, 'muneral-agent-key');
writeFileSync(keyFile, 'mun_sk_example_value_not_a_real_key\n');

const MUNERA_KEYS = [
  'MUNERA_BASE_URL',
  'MUNERA_API_TOKEN',
  'MUNERAL_AGENT_KEY_FILE',
  'ECOSYSTEM_MUNERA_INTEGRATION',
];

/** What ConfigModule.forRoot does with the environment, in its order. */
function boot(env: Record<string, string>): void {
  for (const k of MUNERA_KEYS) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  validateConfig({ ...process.env });
  muneraConfig();
}

afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('boot with the Muneral environment (A2-313)', () => {
  it('refuses the environment production ran on 2026-09-25 (site host + changeme)', () => {
    expect(() =>
      boot({ ...BASE, MUNERA_BASE_URL: 'https://muneral.com', MUNERA_API_TOKEN: 'changeme' }),
    ).toThrow(/MUNERA_BASE_URL.*SITE/);
  });

  it('refuses a placeholder token even on the right host', () => {
    expect(() =>
      boot({
        ...BASE,
        MUNERA_BASE_URL: 'https://api.muneral.com/api/v1',
        MUNERA_API_TOKEN: 'changeme',
      }),
    ).toThrow(/no usable Muneral credential \(MUNERA_API_TOKEN is a placeholder\)/);
  });

  it('refuses an empty token (the .env line `MUNERA_API_TOKEN=` with no compose default)', () => {
    expect(() =>
      boot({ ...BASE, MUNERA_BASE_URL: 'https://api.muneral.com/api/v1', MUNERA_API_TOKEN: '' }),
    ).toThrow(/no usable Muneral credential/);
  });

  it('refuses a key file that is configured but missing', () => {
    expect(() =>
      boot({
        ...BASE,
        MUNERA_BASE_URL: 'https://api.muneral.com/api/v1',
        MUNERAL_AGENT_KEY_FILE: join(dir, 'absent'),
      }),
    ).toThrow(/MUNERAL_AGENT_KEY_FILE unreadable/);
  });

  it('boots the A2-281 key-file compose, which passes no MUNERA_API_TOKEN', () => {
    expect(() =>
      boot({
        ...BASE,
        MUNERA_BASE_URL: 'https://api.muneral.com/api/v1',
        MUNERAL_AGENT_KEY_FILE: keyFile,
      }),
    ).not.toThrow();
  });

  it('boots without any credential only when the integration is explicitly off', () => {
    expect(() =>
      boot({
        ...BASE,
        MUNERA_BASE_URL: 'https://api.muneral.com/api/v1',
        ECOSYSTEM_MUNERA_INTEGRATION: 'false',
      }),
    ).not.toThrow();
  });

  it('never puts the credential into the refusal', () => {
    let message = '';
    try {
      boot({ ...BASE, MUNERA_BASE_URL: 'https://muneral.com', MUNERAL_AGENT_KEY_FILE: keyFile });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('mun_sk_');
  });

  // A2-360 — every other address in the muneral.com zone that is not the API,
  // as measured 2026-09-25 (`out-hosts.txt`): each must refuse at boot and say why.
  it.each([
    ['https://muneral.com', /MUNERA_BASE_URL: points at the Muneral SITE/],
    ['https://www.muneral.com/api/v1', /MUNERA_BASE_URL: points at the Muneral SITE/],
    [
      'https://app.muneral.com/api/v1',
      /MUNERA_BASE_URL: host app\.muneral\.com is not the Muneral API/,
    ],
    ['http://api.muneral.com/api/v1', /MUNERA_BASE_URL: must be https:\/\/ for a public host/],
  ])('refuses MUNERA_BASE_URL=%s with the reason, even with a usable key', (url, reason) => {
    expect(() => boot({ ...BASE, MUNERA_BASE_URL: url, MUNERAL_AGENT_KEY_FILE: keyFile })).toThrow(
      reason,
    );
  });

  it.each([
    'https://api.muneral.com/api/v1',
    'https://api.muneral.com',
    'http://127.0.0.1:3500/api/v1',
    'http://muneral-api:3500',
    'http://100.90.7.20:3500/api/v1',
  ])('boots MUNERA_BASE_URL=%s (API host, loopback, docker name, mesh)', (url) => {
    expect(() =>
      boot({ ...BASE, MUNERA_BASE_URL: url, MUNERAL_AGENT_KEY_FILE: keyFile }),
    ).not.toThrow();
  });

  // A2-360 — a refusal to boot must be about OUR configuration, never about
  // Muneral's reachability. Boot is judged on the environment alone: no request
  // leaves the process, so an unreachable Muneral cannot stop the container.
  it('boots with a usable key while Muneral is unreachable — and never touches the network', () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      expect(() =>
        boot({
          ...BASE,
          MUNERA_BASE_URL: 'http://127.0.0.1:1/api/v1',
          MUNERAL_AGENT_KEY_FILE: keyFile,
        }),
      ).not.toThrow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
