import { describe, expect, it } from 'vitest';

import { ProactiveMetricsService } from './proactive-metrics.service.js';

describe('ProactiveMetricsService', () => {
  it('increments per kind+outcome', () => {
    const m = new ProactiveMetricsService();
    m.inc('briefing', 'sent');
    m.inc('briefing', 'sent');
    m.inc('briefing', 'failed');
    m.inc('digest', 'sent');
    expect(m.value('briefing', 'sent')).toBe(2);
    expect(m.value('briefing', 'failed')).toBe(1);
    expect(m.value('digest', 'sent')).toBe(1);
    expect(m.value('digest', 'failed')).toBe(0);
  });

  it('snapshot returns full map', () => {
    const m = new ProactiveMetricsService();
    m.inc('briefing', 'sent');
    m.inc('digest', 'skipped');
    expect(m.snapshot()).toEqual({ 'briefing:sent': 1, 'digest:skipped': 1 });
  });
});
