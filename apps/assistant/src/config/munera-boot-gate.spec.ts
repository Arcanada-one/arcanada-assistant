/**
 * A2-374 — a boot refusal names its cause with a code and an exit status of its
 * own, and nothing about Muneral's reachability can produce one.
 *
 * Environments are the ones measured, not invented: `PROD_2026_09_25` is
 * `docker inspect arcanada-assistant-assistant-1` on arcana-prd (A2-313 §2):
 * the site host and the 8-byte placeholder the compose default filled in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkMuneraBoot, EX_CONFIG, formatBootRefusal } from './munera-boot-gate.js';

const KEY = 'mun_sk_example_value_not_a_real_key';
const keyFile = (path: string): string => {
  if (path !== '/run/secrets/muneral-agent-key') throw new Error(`ENOENT: ${path}`);
  return `${KEY}\n`;
};
const PROD_2026_09_25 = { MUNERA_BASE_URL: 'https://muneral.com', MUNERA_API_TOKEN: 'changeme' };
const COMPOSE_A2_281 = { MUNERAL_AGENT_KEY_FILE: '/run/secrets/muneral-agent-key' };

afterEach(() => vi.unstubAllGlobals());

describe('checkMuneraBoot (A2-374)', () => {
  it('no key at all → MUNERA_CREDENTIAL_MISSING, exit 78', () => {
    const gate = checkMuneraBoot({}, keyFile);
    expect(gate).toMatchObject({
      ok: false,
      code: 'MUNERA_CREDENTIAL_MISSING',
      exitCode: EX_CONFIG,
    });
  });

  it('placeholder token on the API host → MUNERA_CREDENTIAL_MISSING', () => {
    const gate = checkMuneraBoot({ MUNERA_API_TOKEN: 'changeme' }, keyFile);
    expect(gate).toMatchObject({ ok: false, code: 'MUNERA_CREDENTIAL_MISSING' });
  });

  it('key file configured but not mounted → MUNERA_CREDENTIAL_MISSING, says unreadable', () => {
    const gate = checkMuneraBoot({ MUNERAL_AGENT_KEY_FILE: '/run/secrets/absent' }, keyFile);
    expect(gate).toMatchObject({ ok: false, code: 'MUNERA_CREDENTIAL_MISSING' });
    expect(!gate.ok && gate.message).toMatch(/unreadable/);
  });

  it('the environment production ran on 2026-09-25 → MUNERA_BASE_URL_INVALID', () => {
    const gate = checkMuneraBoot(PROD_2026_09_25, keyFile);
    expect(gate).toMatchObject({ ok: false, code: 'MUNERA_BASE_URL_INVALID', exitCode: EX_CONFIG });
    expect(!gate.ok && gate.message).toMatch(/SITE/);
  });

  it('mutant: the site address with a GOOD key file is still refused', () => {
    const gate = checkMuneraBoot(
      { ...COMPOSE_A2_281, MUNERA_BASE_URL: 'https://muneral.com' },
      keyFile,
    );
    expect(gate).toMatchObject({ ok: false, code: 'MUNERA_BASE_URL_INVALID' });
  });

  it('a bad project id is a config fault, not a missing key', () => {
    const gate = checkMuneraBoot({ ...COMPOSE_A2_281, MUNERAL_PROJECT_ID: 'nope' }, keyFile);
    expect(gate).toMatchObject({ ok: false, code: 'MUNERA_CONFIG_INVALID' });
  });

  it('the A2-281 compose (key file, no base URL) boots on the canonical API address', () => {
    const gate = checkMuneraBoot(COMPOSE_A2_281, keyFile);
    expect(gate).toEqual({
      ok: true,
      integrationEnabled: true,
      source: 'key-file',
      bytes: KEY.length,
      baseUrl: 'https://api.muneral.com/api/v1',
    });
  });

  it('never touches the network: a dead Muneral cannot become a boot refusal', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('network must not be touched at boot');
    });
    vi.stubGlobal('fetch', fetchSpy);
    expect(
      checkMuneraBoot({ ...COMPOSE_A2_281, MUNERA_BASE_URL: 'http://127.0.0.1:1' }, keyFile),
    ).toMatchObject({ ok: true });
    expect(checkMuneraBoot({}, keyFile)).toMatchObject({ ok: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('integration off boots without a key', () => {
    expect(checkMuneraBoot({ ECOSYSTEM_MUNERA_INTEGRATION: 'false' }, keyFile)).toMatchObject({
      ok: true,
      integrationEnabled: false,
    });
  });

  it('the refusal line carries the code and never the key', () => {
    const gate = checkMuneraBoot(
      { ...COMPOSE_A2_281, MUNERA_BASE_URL: 'https://app.muneral.com/api/v1' },
      keyFile,
    );
    if (gate.ok) throw new Error('expected a refusal');
    const line = formatBootRefusal(gate);
    expect(line).toMatch(/^munera boot refused code=MUNERA_BASE_URL_INVALID exit=78: /);
    expect(line).not.toContain(KEY);
  });
});
