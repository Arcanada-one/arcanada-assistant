/**
 * A dependency probe = a self-contained liveness check for one external system
 * (Postgres / Redis / Scrutator / Model Connector / Ops Bot / Auth Arcana).
 *
 * Implementations live next to their clients in `apps/assistant` (production)
 * or in tests (mock probes). This module owns only the interface + the
 * timeout-aware runner.
 */
export interface DepProbe {
  readonly name: string;
  /** Throw on failure; return on success. Latency measurement is wrapper's job. */
  check(): Promise<void>;
}

export type ProbeStatus = 'ok' | 'fail' | 'pending-integration';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  latencyMs: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Runs a probe with timeout + latency measurement. Never throws — returns
 * a structured result that callers (Terminus health-controller) aggregate
 * into the response body.
 */
export async function runProbe(
  probe: DepProbe,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = performance.now();

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`probe timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([probe.check(), timeoutPromise]);
    return {
      name: probe.name,
      status: 'ok',
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      name: probe.name,
      status: 'fail',
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/** Sentinel result for not-yet-wired dependencies (Scrutator/MC/OpsBot/AA in scaffold). */
export function pendingIntegration(name: string): ProbeResult {
  return { name, status: 'pending-integration', latencyMs: 0 };
}
