import { Injectable, Logger } from '@nestjs/common';

import type { DispatchOutcome, ProactiveKind } from './proactive.types.js';

type CounterKey = `${ProactiveKind}:${DispatchOutcome}`;

/**
 * In-memory counter shim for `assistant_proactive_dispatched_total{kind,outcome}`.
 * Real Prometheus `/metrics` endpoint is not yet wired in the assistant
 * (no prom-client dep). This shim satisfies the V-AC-1/V-AC-2 contract via
 * (a) live readable value, (b) structured pino log on every increment so a
 * Loki/Grafana derived metric can be built later. Drop-in replaceable with
 * a `prom-client` Counter once the `/metrics` endpoint lands.
 */
@Injectable()
export class ProactiveMetricsService {
  private readonly logger = new Logger(ProactiveMetricsService.name);
  private readonly counts = new Map<CounterKey, number>();

  inc(kind: ProactiveKind, outcome: DispatchOutcome): void {
    const key = `${kind}:${outcome}` as CounterKey;
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    this.logger.log(
      `metric=assistant_proactive_dispatched_total kind=${kind} outcome=${outcome} value=${next}`,
    );
  }

  value(kind: ProactiveKind, outcome: DispatchOutcome): number {
    return this.counts.get(`${kind}:${outcome}` as CounterKey) ?? 0;
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.counts);
  }
}
