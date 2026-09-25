/**
 * A2-374 — "does the service see its Muneral key?", answered by the service's
 * own code, without printing the key.
 *
 *   node dist/munera-check.js            config only, no network
 *   node dist/munera-check.js --probe    plus ONE GET /api/v1/tasks/digest
 *
 * Prints one JSON line and exits with a code that names the fault
 * (see munera-boot-gate.ts): 0 key usable, 78 our config, 77 key rejected,
 * 69 Muneral did not answer. Run inside the container:
 *   docker exec <container> node dist/munera-check.js --probe
 */
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_MUNERA_USER_AGENT,
  normaliseMuneraBaseUrl,
} from './agents/munera/munera.client.js';
import {
  checkMuneraBoot,
  EX_CONFIG,
  EX_NOPERM,
  EX_UNAVAILABLE,
} from './config/munera-boot-gate.js';
import { resolveMuneraCredential } from './config/munera.config.js';

export interface MuneraCheckResult {
  exitCode: number;
  line: Record<string, unknown>;
}

export interface MuneraCheckOptions {
  probe: boolean;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => string;
  timeoutMs?: number;
}

export async function runMuneraCheck(
  env: NodeJS.ProcessEnv,
  opts: MuneraCheckOptions,
): Promise<MuneraCheckResult> {
  const gate = checkMuneraBoot(env, opts.readFile);
  if (!gate.ok) {
    return {
      exitCode: gate.exitCode,
      line: { check: 'munera', ok: false, code: gate.code, detail: gate.message },
    };
  }
  const base = { check: 'munera', source: gate.source, bytes: gate.bytes, baseUrl: gate.baseUrl };
  if (!gate.integrationEnabled) {
    return { exitCode: 0, line: { ...base, ok: true, code: 'MUNERA_INTEGRATION_DISABLED' } };
  }
  if (!opts.probe) return { exitCode: 0, line: { ...base, ok: true, code: 'MUNERA_KEY_PRESENT' } };

  // Re-resolved here so the gate's result never has to carry the key.
  const { token } = resolveMuneraCredential(env, opts.readFile);
  const url = `${normaliseMuneraBaseUrl(gate.baseUrl)}/api/v1/tasks/digest`;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': DEFAULT_MUNERA_USER_AGENT,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return {
      exitCode: EX_UNAVAILABLE,
      line: { ...base, ok: false, code: 'MUNERA_UNREACHABLE', detail: networkDetail(err) },
    };
  }
  const bodyCode = await readBodyCode(res);
  const probe = { ...base, status: res.status, ...(bodyCode ? { bodyCode } : {}) };
  if (res.status >= 300 && res.status < 400) {
    return {
      exitCode: EX_CONFIG,
      line: {
        ...probe,
        ok: false,
        code: 'MUNERA_BASE_URL_INVALID',
        detail: 'API answered a redirect',
      },
    };
  }
  if (res.status === 401) {
    return {
      exitCode: EX_NOPERM,
      line: { ...probe, ok: false, code: 'MUNERA_CREDENTIAL_REJECTED' },
    };
  }
  // 403 DIGEST_GRANT_REQUIRED / GRANT_EXPIRED: the key was AUTHENTICATED and the
  // workspace grant is what is missing — the key is alive (A2-313 §4).
  if (res.status === 200 || res.status === 403) {
    return { exitCode: 0, line: { ...probe, ok: true, code: 'MUNERA_CREDENTIAL_ACCEPTED' } };
  }
  return { exitCode: EX_UNAVAILABLE, line: { ...probe, ok: false, code: 'MUNERA_UNREACHABLE' } };
}

async function readBodyCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
}

function networkDetail(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  return e.cause?.code ?? e.name ?? e.message ?? 'fetch failed';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = await runMuneraCheck(process.env, { probe: process.argv.includes('--probe') });
  process.stdout.write(`${JSON.stringify(result.line)}\n`);
  process.exit(result.exitCode);
}
