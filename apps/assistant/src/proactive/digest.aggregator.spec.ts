import { describe, expect, it, vi } from 'vitest';

import { DigestAggregator } from './digest.aggregator.js';
import type { DatarimReaderService } from './datarim-reader.service.js';
import type { ProactiveConfig } from './proactive.types.js';

const baseConfig: ProactiveConfig = {
  enabled: true,
  timezone: 'Europe/Istanbul',
  channels: {
    briefing: {
      enabled: true,
      cron: '0 8 * * *',
      chat_id: 100,
      include_active_tasks: true,
      include_backlog_top_n: 3,
      include_ecosystem_snapshot: true,
      include_night_events_section: false,
    },
    digest: {
      enabled: true,
      cron: '0 21 * * *',
      chat_id: 100,
      include_completed_tasks: true,
      include_archived_items: true,
      include_key_events: false,
    },
  },
  dispatch: {
    max_attempts: 3,
    base_backoff_ms: 1000,
    self_heal_threshold: 3,
    fallback_to_plain_text_on_md_error: true,
  },
  observability: { pino_level: 'info', prometheus_counter: 'assistant_proactive_dispatched_total' },
};

function stubReader(opts: {
  completed?: Array<{ id: string; title: string }>;
  archived?: Array<{ id: string; subdir: string; mtime: Date }>;
  backlog?: Array<{ id: string; title: string; priority: string; complexity: string }>;
  sourceAvailable?: boolean;
}): DatarimReaderService {
  return {
    readActiveTasks: vi.fn().mockResolvedValue([]),
    readBacklogTopN: vi.fn().mockResolvedValue(opts.backlog ?? []),
    readCompletedToday: vi.fn().mockResolvedValue(opts.completed ?? []),
    readArchivedToday: vi.fn().mockResolvedValue(opts.archived ?? []),
    sourceAvailable: vi.fn().mockResolvedValue(opts.sourceAvailable ?? true),
  } as unknown as DatarimReaderService;
}

describe('DigestAggregator', () => {
  it('produces three section headers per V-AC-2', async () => {
    const agg = new DigestAggregator(
      stubReader({
        completed: [{ id: 'ARCA-0009', title: 'Agent Mesh' }],
        archived: [{ id: 'TRANS-0060', subdir: 'transcribator', mtime: new Date() }],
        backlog: [{ id: 'INFRA-0235', title: 'X', priority: 'P0', complexity: 'L2' }],
      }),
    );
    const out = await agg.compose({ runDate: '2026-05-18', config: baseConfig });
    expect(out.text).toContain('*Завершено сегодня*');
    expect(out.text).toContain('*Архив сегодня*');
    expect(out.text).toContain('*В очереди на завтра*');
    expect(out.sections).toEqual(['completed_today', 'archived_today', 'backlog_tomorrow']);
  });

  it('renders "— нет" / "— пусто" placeholders when sections empty but source available', async () => {
    const agg = new DigestAggregator(stubReader({ sourceAvailable: true }));
    const out = await agg.compose({ runDate: '2026-05-18', config: baseConfig });
    expect(out.text).toContain('— нет');
    expect(out.text).toContain('— пусто');
    expect(out.text).not.toContain('источник недоступен');
  });

  // ARCA-0154 wish #4: broken datarim source → degraded marker, not "— нет".
  it('renders degraded marker for datarim sections when source unavailable', async () => {
    const agg = new DigestAggregator(stubReader({ sourceAvailable: false }));
    const out = await agg.compose({ runDate: '2026-05-18', config: baseConfig });
    expect(out.text).toContain('источник недоступен');
  });

  it('escapes task IDs in MarkdownV2', async () => {
    const agg = new DigestAggregator(
      stubReader({
        completed: [{ id: 'ARCA-0009', title: 'done' }],
      }),
    );
    const out = await agg.compose({ runDate: '2026-05-18', config: baseConfig });
    expect(out.text).toContain('ARCA\\-0009');
  });
});
