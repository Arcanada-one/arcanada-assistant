import { readFileSync } from 'node:fs';

import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const envSchema = z.object({
  /**
   * Accepts the canonical `https://api.muneral.com/api/v1` from AGENTS.md as
   * well as a bare origin — `normaliseMuneraBaseUrl` strips the duplicate path.
   */
  MUNERA_BASE_URL: z.string().url().default('https://api.muneral.com/api/v1'),
  /**
   * A2-281 — path to a file holding the agent key (`mun_sk_…`), mounted
   * read-only into the container. A KEY IS NOT AN ENVIRONMENT VARIABLE: env is
   * visible in `docker inspect`, in `/proc/<pid>/environ`, in every crash dump
   * and in any log that ever prints the environment. A file has an owner and a
   * mode.
   */
  MUNERAL_AGENT_KEY_FILE: z.string().min(1).optional(),
  /**
   * Deprecated credential path, kept so an existing deployment does not lose
   * access the moment this ships. Prefer `MUNERAL_AGENT_KEY_FILE`.
   */
  MUNERA_API_TOKEN: z.string().min(1).optional(),
  /** Narrows the proactive reads to one Muneral project. Unset ⇒ no narrowing. */
  MUNERAL_PROJECT_ID: z.string().uuid().optional(),
  MUNERA_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ECOSYSTEM_MUNERA_INTEGRATION: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v !== 'false'),
});

export type MuneraCredentialSource = 'key-file' | 'env' | 'none';

export interface MuneraCredential {
  /** `null` when nothing usable is configured — never a placeholder string. */
  token: string | null;
  source: MuneraCredentialSource;
  /** Why, in words, for the boot log. Never contains the credential itself. */
  detail: string;
}

export interface MuneraConfig {
  baseUrl: string;
  credential: MuneraCredential;
  projectId?: string;
  timeoutMs: number;
  integrationEnabled: boolean;
}

export const MUNERA_CONFIG = 'munera';

/**
 * Values that are present in the environment and mean "nobody set this".
 * `changeme` is not hypothetical: it is what production carried in
 * `MUNERA_API_TOKEN` on 2026-09-24 (A2-281).
 */
const PLACEHOLDERS = new Set(['changeme', 'change-me', 'replace-me', 'todo', '']);

export function resolveMuneraCredential(
  env: { MUNERAL_AGENT_KEY_FILE?: string; MUNERA_API_TOKEN?: string },
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
): MuneraCredential {
  const path = env.MUNERAL_AGENT_KEY_FILE;
  if (path) {
    let raw: string;
    try {
      raw = readFile(path).trim();
    } catch (err) {
      // The path was configured and the file is not readable. That is a
      // deployment fault to be reported as such — falling through to the env
      // token here would hide a broken mount behind a stale credential.
      return {
        token: null,
        source: 'none',
        detail: `MUNERAL_AGENT_KEY_FILE unreadable: ${(err as Error).message}`,
      };
    }
    if (PLACEHOLDERS.has(raw.toLowerCase())) {
      return { token: null, source: 'none', detail: 'key file holds a placeholder' };
    }
    return { token: raw, source: 'key-file', detail: `key file (${raw.length} bytes)` };
  }

  const envToken = env.MUNERA_API_TOKEN?.trim();
  if (envToken && !PLACEHOLDERS.has(envToken.toLowerCase())) {
    return {
      token: envToken,
      source: 'env',
      detail: 'MUNERA_API_TOKEN (deprecated — move to MUNERAL_AGENT_KEY_FILE)',
    };
  }
  return {
    token: null,
    source: 'none',
    detail: envToken
      ? 'MUNERA_API_TOKEN is a placeholder'
      : 'no MUNERAL_AGENT_KEY_FILE and no MUNERA_API_TOKEN',
  };
}

/**
 * An env var set to the empty string is UNSET, not invalid. Compose writes `''`
 * for `${VAR:-}`, so a blank `MUNERAL_PROJECT_ID` — the normal "no narrowing"
 * case — would otherwise fail uuid validation and take the whole app down at
 * boot. Dropped before validation rather than wrapped in `z.preprocess`: the
 * wrapper erases the field's declared type, and the contract differ then reads
 * an optional string as a NEW REQUIRED `any`.
 */
export function withoutBlanks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
}

export default registerAs(MUNERA_CONFIG, (): MuneraConfig => {
  const parsed = envSchema.safeParse(withoutBlanks(process.env));
  if (!parsed.success) {
    throw new Error(
      `Invalid Munera configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return {
    baseUrl: parsed.data.MUNERA_BASE_URL,
    credential: resolveMuneraCredential(parsed.data),
    ...(parsed.data.MUNERAL_PROJECT_ID ? { projectId: parsed.data.MUNERAL_PROJECT_ID } : {}),
    timeoutMs: parsed.data.MUNERA_TIMEOUT_MS,
    integrationEnabled: parsed.data.ECOSYSTEM_MUNERA_INTEGRATION,
  };
});
