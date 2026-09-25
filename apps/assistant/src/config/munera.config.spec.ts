import { describe, expect, it } from 'vitest';

import { resolveMuneraCredential, withoutBlanks } from './munera.config.js';

describe('resolveMuneraCredential (A2-281)', () => {
  it('reads the agent key from the file named by MUNERAL_AGENT_KEY_FILE', () => {
    const c = resolveMuneraCredential(
      { MUNERAL_AGENT_KEY_FILE: '/run/secrets/muneral-agent-key' },
      () => 'mun_sk_example_value_not_a_real_key\n',
    );
    expect(c.source).toBe('key-file');
    expect(c.token).toBe('mun_sk_example_value_not_a_real_key');
    // The detail line goes into the boot log — it must not carry the secret.
    expect(c.detail).not.toContain('mun_sk_');
  });

  /**
   * Production carried `MUNERA_API_TOKEN=changeme` on 2026-09-24. A placeholder
   * must resolve to "no credential", not to a credential that earns a 401: the
   * two look the same in a log and only one of them is a deployment mistake.
   */
  it('treats a placeholder as no credential at all', () => {
    const c = resolveMuneraCredential({ MUNERA_API_TOKEN: 'changeme' });
    expect(c.token).toBeNull();
    expect(c.source).toBe('none');
    expect(c.detail).toContain('placeholder');
  });

  it('reports an unreadable key file instead of falling back to the env token', () => {
    const c = resolveMuneraCredential(
      { MUNERAL_AGENT_KEY_FILE: '/run/secrets/missing', MUNERA_API_TOKEN: 'mun_sk_stale' },
      () => {
        throw new Error('ENOENT: no such file or directory');
      },
    );
    expect(c.token).toBeNull();
    expect(c.detail).toContain('unreadable');
  });

  it('still accepts the deprecated env token when no key file is configured', () => {
    const c = resolveMuneraCredential({ MUNERA_API_TOKEN: 'mun_sk_env_value' });
    expect(c).toMatchObject({ token: 'mun_sk_env_value', source: 'env' });
    expect(c.detail).toContain('deprecated');
  });

  it('answers "none" with a reason when nothing is configured', () => {
    expect(resolveMuneraCredential({})).toMatchObject({ token: null, source: 'none' });
  });
});

describe('withoutBlanks (A2-281)', () => {
  it('drops an empty env var so `${VAR:-}` in compose reads as unset', () => {
    expect(withoutBlanks({ MUNERAL_PROJECT_ID: '', MUNERA_TIMEOUT_MS: '5000' })).toEqual({
      MUNERA_TIMEOUT_MS: '5000',
    });
  });
});
