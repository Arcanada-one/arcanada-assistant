import type { EcosystemSnapshot } from './ops-bot.types.js';

// Linear-time regex (each subgroup operates on disjoint character classes,
// no nested unbounded repetition) — ReDoS-safe by construction.
// eslint-disable-next-line security/detect-unsafe-regex
const METRIC_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([-+0-9.eE]+|NaN|\+?Inf|-Inf)\s*$/;

const COUNTERS = {
  agents_total: ['opsbot_agents_total'],
  events_total: ['opsbot_events_total'],
  approvals_pending: ['opsbot_approvals_pending'],
} as const satisfies Record<keyof Omit<EcosystemSnapshot, 'parsed_at'>, readonly string[]>;

/**
 * Minimal Prometheus exposition-format parser. Sums labelled samples sharing
 * the same metric name; ignores `# HELP` / `# TYPE` / blank lines; treats
 * `NaN`/`Inf` and other non-finite values as 0 contribution.
 */
export function parsePrometheusSnapshot(text: string): EcosystemSnapshot {
  const accumulators: Record<keyof typeof COUNTERS, number> = {
    agents_total: 0,
    events_total: 0,
    approvals_pending: 0,
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = METRIC_LINE.exec(line);
    if (!match) continue;
    const [, name, valueRaw] = match;
    const value = Number(valueRaw);
    if (!Number.isFinite(value)) continue;
    for (const [bucket, names] of Object.entries(COUNTERS) as [
      keyof typeof COUNTERS,
      readonly string[],
    ][]) {
      if (names.includes(name)) {
        accumulators[bucket] += value;
        break;
      }
    }
  }

  return {
    agents_total: Math.trunc(accumulators.agents_total),
    events_total: Math.trunc(accumulators.events_total),
    approvals_pending: Math.trunc(accumulators.approvals_pending),
    parsed_at: new Date().toISOString(),
  };
}
