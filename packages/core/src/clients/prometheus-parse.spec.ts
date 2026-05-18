import { describe, it, expect } from 'vitest';

import { parsePrometheusSnapshot } from './prometheus-parse.js';

const SAMPLE_OPS_BOT_METRICS = `# HELP opsbot_agents_total Total registered agents
# TYPE opsbot_agents_total gauge
opsbot_agents_total 5
# HELP opsbot_events_total Events received
# TYPE opsbot_events_total counter
opsbot_events_total{category="fatal"} 2
opsbot_events_total{category="info"} 40
# HELP opsbot_approvals_pending Pending approvals
# TYPE opsbot_approvals_pending gauge
opsbot_approvals_pending 1
`;

describe('parsePrometheusSnapshot', () => {
  it('extracts agents_total, events_total (sum), approvals_pending', () => {
    const result = parsePrometheusSnapshot(SAMPLE_OPS_BOT_METRICS);
    expect(result.agents_total).toBe(5);
    expect(result.events_total).toBe(42);
    expect(result.approvals_pending).toBe(1);
    expect(typeof result.parsed_at).toBe('string');
  });

  it('returns zeros when no matching metrics present', () => {
    const result = parsePrometheusSnapshot('# nothing useful\nfoo_bar 99\n');
    expect(result.agents_total).toBe(0);
    expect(result.events_total).toBe(0);
    expect(result.approvals_pending).toBe(0);
  });

  it('skips comments and HELP/TYPE lines', () => {
    const text = '# HELP foo bar\n# TYPE foo gauge\nopsbot_agents_total 7\n';
    const result = parsePrometheusSnapshot(text);
    expect(result.agents_total).toBe(7);
  });

  it('handles labelled and unlabelled events_total combined', () => {
    const text = 'opsbot_events_total 3\nopsbot_events_total{x="y"} 4\n';
    const result = parsePrometheusSnapshot(text);
    expect(result.events_total).toBe(7);
  });

  it('treats malformed numeric values as 0 contribution', () => {
    const text = 'opsbot_agents_total NaN\nopsbot_events_total 5\n';
    const result = parsePrometheusSnapshot(text);
    expect(result.agents_total).toBe(0);
    expect(result.events_total).toBe(5);
  });
});
