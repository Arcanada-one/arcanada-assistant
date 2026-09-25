import { readFileSync } from 'node:fs';

import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * A2-313 — hosts that answer on the Muneral name but are not its API. Production
 * ran with `MUNERA_BASE_URL=https://muneral.com` (the site): measured 2026-09-25,
 * `GET https://muneral.com/api/v1/tasks/digest` → 302 to the site, never an API
 * answer. `normaliseMuneraBaseUrl` repairs a duplicated `/api/v1` on the right
 * host; it cannot repair the wrong host, so the wrong host is refused at boot.
 */
const MUNERAL_SITE_HOSTS = new Set(['muneral.com', 'www.muneral.com']);

/** The one public host that serves the Muneral API. */
const MUNERAL_API_HOST = 'api.muneral.com';

/** Hosts on which plaintext `http://` never leaves the machine or the mesh. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isPrivateHttpHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true; // Tailscale CGNAT
  // RFC 6761 special-use names never resolve to a public host. CI's smoke job
  // runs the real process against `http://stub.invalid:3500` (ci.yml).
  if (/(^|\.)(invalid|test|localhost)$/.test(hostname)) return true;
  return hostname.length > 0 && !hostname.includes('.'); // docker service name
}

export const MUNERAL_SITE_HOST_MESSAGE =
  'points at the Muneral SITE, not its API — use https://api.muneral.com/api/v1';

/**
 * A2-360 — why this URL cannot be the Muneral API, or `null` when it can.
 *
 * The site hosts were the only refusal in A2-313. Measured 2026-09-25 from
 * arcana-devs, the rest of the `muneral.com` zone is no better:
 * `https://app.muneral.com/api/v1/tasks/digest` → 502, and
 * `http://api.muneral.com/…` → 301 to https. The 301 is the worse one: the key
 * goes out in clear on the first hop, and fetch drops `Authorization` on the
 * cross-origin redirect, so what comes back is a 401 that reads like a dead key.
 * Every one of these is a deployment typo; each is refused at boot with the
 * reason, not discovered as an empty briefing a day later.
 */
export function muneraBaseUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'is not a URL';
  }
  const host = url.hostname.toLowerCase();
  if (MUNERAL_SITE_HOSTS.has(host)) return MUNERAL_SITE_HOST_MESSAGE;
  if (host.endsWith('.muneral.com') && host !== MUNERAL_API_HOST) {
    return `host ${host} is not the Muneral API — use https://api.muneral.com/api/v1`;
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && isPrivateHttpHost(host)) return null;
  return `must be https:// for a public host (${url.protocol}//${host} would send the agent key in clear)`;
}

/** Zod refinement that reports the specific reason, shared by both env schemas. */
export function refineMuneraBaseUrl(value: string, ctx: z.RefinementCtx): void {
  const problem = muneraBaseUrlProblem(value);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
}

const envSchema = z.object({
  /**
   * Accepts the canonical `https://api.muneral.com/api/v1` from AGENTS.md as
   * well as a bare origin — `normaliseMuneraBaseUrl` strips the duplicate path.
   */
  MUNERA_BASE_URL: z
    .string()
    .url()
    .superRefine(refineMuneraBaseUrl)
    .default('https://api.muneral.com/api/v1'),
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
 * A2-374 — why the process refused to boot, as a stable code an operator can
 * grep for. Every boot refusal here is OUR configuration: nothing in this file
 * touches the network, so "Muneral is down" can never produce one (A2-360 §3).
 */
export type MuneraBootCode =
  'MUNERA_CREDENTIAL_MISSING' | 'MUNERA_BASE_URL_INVALID' | 'MUNERA_CONFIG_INVALID';

export class MuneraBootRefusal extends Error {
  constructor(
    readonly code: MuneraBootCode,
    message: string,
  ) {
    super(message);
    this.name = 'MuneraBootRefusal';
  }
}

/**
 * A2-313 — with the integration ON, no usable credential is a refusal to boot.
 *
 * Production ran 36 hours `healthy` on `MUNERA_API_TOKEN=changeme`: every call
 * got 401, 401 is a client fault the breaker does not count, so `/health`
 * reported munera `ok` the whole time. A2-281 made the placeholder degrade each
 * CALL; that still lets the process come up and report itself healthy. A
 * deployment that asks for Muneral and supplies no key is misconfigured, and the
 * place to say so is the boot log of a container that did not start.
 *
 * Running WITHOUT Muneral stays possible, and explicit:
 * `ECOSYSTEM_MUNERA_INTEGRATION=false`. The thrown message carries the
 * resolver's `detail`, which never contains the credential.
 */
export function assertUsableCredential(
  credential: MuneraCredential,
  integrationEnabled: boolean,
): void {
  if (!integrationEnabled || credential.token !== null) return;
  throw new MuneraBootRefusal(
    'MUNERA_CREDENTIAL_MISSING',
    `Invalid Munera configuration: no usable Muneral credential (${credential.detail}). ` +
      'Set MUNERAL_AGENT_KEY_FILE to the agent key file, or ECOSYSTEM_MUNERA_INTEGRATION=false ' +
      'to run without Muneral.',
  );
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

/**
 * The Munera namespace from an environment — what `registerAs` below runs, and
 * what `munera-boot-gate.ts` runs before Nest is imported. Throws
 * `MuneraBootRefusal`; never touches the network.
 */
export function loadMuneraConfig(
  env: NodeJS.ProcessEnv,
  readFile?: (path: string) => string,
): MuneraConfig {
  const parsed = envSchema.safeParse(withoutBlanks(env));
  if (!parsed.success) {
    const onlyBaseUrl = parsed.error.issues.every((i) => i.path[0] === 'MUNERA_BASE_URL');
    throw new MuneraBootRefusal(
      onlyBaseUrl ? 'MUNERA_BASE_URL_INVALID' : 'MUNERA_CONFIG_INVALID',
      `Invalid Munera configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const credential = resolveMuneraCredential(parsed.data, readFile);
  assertUsableCredential(credential, parsed.data.ECOSYSTEM_MUNERA_INTEGRATION);
  return {
    baseUrl: parsed.data.MUNERA_BASE_URL,
    credential,
    ...(parsed.data.MUNERAL_PROJECT_ID ? { projectId: parsed.data.MUNERAL_PROJECT_ID } : {}),
    timeoutMs: parsed.data.MUNERA_TIMEOUT_MS,
    integrationEnabled: parsed.data.ECOSYSTEM_MUNERA_INTEGRATION,
  };
}

export default registerAs(MUNERA_CONFIG, (): MuneraConfig => loadMuneraConfig(process.env));
