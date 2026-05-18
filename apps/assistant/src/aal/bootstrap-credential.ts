import { Injectable, Logger } from '@nestjs/common';

/**
 * ARCA-0009 M8 D4 — bootstrap credential validation (V-AC-10).
 *
 * Each integration-bound agent module registers a probe at construction
 * time. On Nest's `onApplicationBootstrap` lifecycle event, every probe is
 * invoked. Outcomes are classified:
 *
 *   - `missing_config` ⇒ throw `BootstrapConfigError` → fail-fast (the
 *      missing env / Vault key is a developer / ops error that must surface
 *      before traffic flows).
 *   - `probe_failed` ⇒ log warn + continue. The agent's circuit breaker
 *      will open organically on the first real call; the boot probe is a
 *      diagnostic, not a hard gate.
 *
 * Callers may pass `requireSuccess: true` when the agent is critical and
 * cannot tolerate a degraded boot (e.g. Auth Arcana on a service that has
 * no fallback).
 */

export type CredentialProbeOutcome =
  | { ok: true; detail?: string }
  | { ok: false; kind: 'missing_config'; detail: string }
  | { ok: false; kind: 'probe_failed'; detail: string };

export interface CredentialProbe {
  name: string;
  agent?: string;
  requireSuccess?: boolean;
  probe(): Promise<CredentialProbeOutcome>;
}

export class BootstrapConfigError extends Error {
  readonly probeName: string;
  constructor(probeName: string, message: string) {
    super(`bootstrap credential check failed (${probeName}): ${message}`);
    this.name = 'BootstrapConfigError';
    this.probeName = probeName;
  }
}

@Injectable()
export class BootstrapCredentialRegistry {
  private readonly logger = new Logger(BootstrapCredentialRegistry.name);
  private readonly probes: CredentialProbe[] = [];

  register(probe: CredentialProbe): void {
    this.probes.push(probe);
  }

  list(): readonly CredentialProbe[] {
    return [...this.probes];
  }

  async runAll(): Promise<
    ReadonlyArray<{ probe: CredentialProbe; outcome: CredentialProbeOutcome }>
  > {
    const results: { probe: CredentialProbe; outcome: CredentialProbeOutcome }[] = [];
    for (const probe of this.probes) {
      const outcome = await this.runOne(probe);
      results.push({ probe, outcome });
    }
    return results;
  }

  private async runOne(probe: CredentialProbe): Promise<CredentialProbeOutcome> {
    try {
      const outcome = await probe.probe();
      if (outcome.ok) {
        this.logger.log(
          `probe "${probe.name}" → ok${outcome.detail ? ` (${outcome.detail})` : ''}`,
        );
        return outcome;
      }
      if (outcome.kind === 'missing_config') {
        this.logger.error(`probe "${probe.name}" → missing config: ${outcome.detail}`);
        if (probe.requireSuccess !== false) {
          throw new BootstrapConfigError(probe.name, outcome.detail);
        }
        return outcome;
      }
      this.logger.warn(`probe "${probe.name}" → probe failed: ${outcome.detail}`);
      if (probe.requireSuccess === true) {
        throw new BootstrapConfigError(probe.name, outcome.detail);
      }
      return outcome;
    } catch (err) {
      if (err instanceof BootstrapConfigError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`probe "${probe.name}" → threw: ${detail}`);
      if (probe.requireSuccess === true) {
        throw new BootstrapConfigError(probe.name, detail);
      }
      return { ok: false, kind: 'probe_failed', detail };
    }
  }
}

export const BOOTSTRAP_CREDENTIAL_REGISTRY = Symbol.for('BOOTSTRAP_CREDENTIAL_REGISTRY');
