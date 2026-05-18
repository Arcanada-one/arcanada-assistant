import { describe, expect, it, vi } from 'vitest';

import type { EcosystemSnapshot, IOpsBotClient } from '@arcanada/core';

import { BriefingAggregator } from './briefing.aggregator.js';
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

function stubOps(snap: EcosystemSnapshot | Error): IOpsBotClient {
  return {
    emitEvent: vi.fn(),
    executeCommand: vi.fn(),
    healthReady: vi.fn(),
    isCircuitOpen: vi.fn(),
    getEcosystemSnapshot: vi.fn().mockImplementation(() => {
      if (snap instanceof Error) return Promise.reject(snap);
      return Promise.resolve(snap);
    }),
  } as unknown as IOpsBotClient;
}

function stubReader(opts: {
  active?: Array<{ id: string; title: string; priority: string; complexity: string; status: string }>;
  backlog?: Array<{ id: string; title: string; priority: string; complexity: string }>;
}): DatarimReaderService {
  return {
    readActiveTasks: vi.fn().mockResolvedValue(opts.active ?? []),
    readBacklogTopN: vi.fn().mockResolvedValue(opts.backlog ?? []),
    readCompletedToday: vi.fn().mockResolvedValue([]),
    readArchivedToday: vi.fn().mockResolvedValue([]),
  } as unknown as DatarimReaderService;
}

describe('BriefingAggregator', () => {
  it('produces all three sections when enabled', async () => {
    const snap: EcosystemSnapshot = {
      agents_total: 8,
      events_total: 14821,
      approvals_pending: 0,
      parsed_at: '2026-05-18T08:00:00Z',
    };
    const agg = new BriefingAggregator(
      stubOps(snap),
      stubReader({
        active: [{ id: 'ARCA-0010', title: 'Proactive', priority: 'P2', complexity: 'L2', status: 'in_progress' }],
        backlog: [
          { id: 'INFRA-0235', title: 'A', priority: 'P0', complexity: 'L2' },
          { id: 'AUTH-0079', title: 'B', priority: 'P1', complexity: 'L3' },
        ],
      }),
    );
    const out = await agg.compose({ runDate: '2026-05-18', config: baseConfig });
    expect(out.sections).toEqual(['ecosystem_snapshot', 'active_tasks', 'backlog_top_n']);
    expect(out.text).toContain('🌅');
    expect(out.text).toContain('2026\\-05\\-18');
    expect(out.text).toContain('ARCA\\-0010');
    expect(out.text).toContain('INFRA\\-0235');
  });

  it('emits "snapshot недоступен" when OpsBot fails (CB-open or 5xx)', async () => {
    const agg = new BriefingAggregator(
      stubOps(new Error('CB-open')),
      stubReader({ active: [], backlog: [] }),
    );
    const out = await agg.compose({ runDate: '2026-05-18', config: baseConfig });
    expect(out.text).toContain('snapshot недоступен');
  });

  it('skips sections when config flags are false', async () => {
    const cfg: ProactiveConfig = {
      ...baseConfig,
      channels: {
        ...baseConfig.channels,
        briefing: {
          ...baseConfig.channels.briefing,
          include_ecosystem_snapshot: false,
          include_active_tasks: false,
          include_backlog_top_n: 0,
        },
      },
    };
    const agg = new BriefingAggregator(stubOps(new Error('x')), stubReader({}));
    const out = await agg.compose({ runDate: '2026-05-18', config: cfg });
    expect(out.sections).toEqual([]);
  });

  it('renders "нет" when no active tasks', async () => {
    const snap: EcosystemSnapshot = {
      agents_total: 0,
      events_total: 0,
      approvals_pending: 0,
      parsed_at: '2026-05-18T08:00:00Z',
    };
    const agg = new BriefingAggregator(stubOps(snap), stubReader({ active: [], backlog: [] }));
    const out = await agg.compose({ runDate: '2026-05-18', config: baseConfig });
    expect(out.text).toContain('нет');
  });
});
