import {
  loadMuneraConfig,
  MuneraBootRefusal,
  type MuneraBootCode,
  type MuneraCredentialSource,
} from './munera.config.js';

/**
 * A2-374 — exit codes, from sysexits(3), so that the exit status of a container
 * that did not start already says whose fault it was:
 *
 *   - 78 EX_CONFIG      — OUR configuration: no usable key, wrong address.
 *   - 77 EX_NOPERM      — the key reached Muneral and Muneral rejected it (401).
 *   - 69 EX_UNAVAILABLE — Muneral did not answer. Someone else's fault; only the
 *                         probe (`munera-check --probe`) can return it — the
 *                         service itself never refuses to boot on the network.
 *
 * Anything else (1) is a crash that is not about Muneral at all.
 */
export const EX_UNAVAILABLE = 69;
export const EX_NOPERM = 77;
export const EX_CONFIG = 78;

export type MuneraBootGate =
  | {
      ok: true;
      integrationEnabled: boolean;
      source: MuneraCredentialSource;
      /** Length of the key, never the key. */
      bytes: number;
      baseUrl: string;
    }
  | { ok: false; code: MuneraBootCode; exitCode: typeof EX_CONFIG; message: string };

/**
 * The same checks `ConfigModule.forRoot` runs for the Munera namespace, run
 * BEFORE Nest is imported. Without this a refusal surfaces from inside Nest's
 * injector (or at import of app.module) as exit 1 with a stack trace, the same
 * status as any other crash — and a deployment that lost its key looks like a
 * deployment that lost its database.
 */
export function checkMuneraBoot(
  env: NodeJS.ProcessEnv,
  readFile?: (path: string) => string,
): MuneraBootGate {
  try {
    const cfg = loadMuneraConfig(env, readFile);
    return {
      ok: true,
      integrationEnabled: cfg.integrationEnabled,
      source: cfg.credential.source,
      bytes: cfg.credential.token?.length ?? 0,
      baseUrl: cfg.baseUrl,
    };
  } catch (err) {
    if (err instanceof MuneraBootRefusal) {
      return { ok: false, code: err.code, exitCode: EX_CONFIG, message: err.message };
    }
    throw err;
  }
}

/** One line for the boot log: grep for `code=`. Never contains the key. */
export function formatBootRefusal(gate: Extract<MuneraBootGate, { ok: false }>): string {
  return `munera boot refused code=${gate.code} exit=${gate.exitCode}: ${gate.message}`;
}
