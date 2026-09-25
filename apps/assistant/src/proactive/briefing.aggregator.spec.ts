import { describe, expect, it, vi } from 'vitest';
import type { EcosystemSnapshot, IOpsBotClient } from '@arcanada/core';

import { stubMuneraClient } from './__fixtures__/muneral-responses.js';
import { baseProactiveConfig } from './__fixtures__/proactive-config.fixture.js';
import { BriefingAggregator } from './briefing.aggregator.js';
import { MuneralWorkItemsReader } from './muneral-reader.service.js';
import type { ActiveTask, BacklogItem } from './proactive.types.js';
import type { IWorkItemsReader, SourceResult } from './work-items.reader.js';

const RUN_DATE = '2026-09-24';

// MarkdownV2 escapes `-`, so a reference reads `A2\-281` in the wire text.
// Asserting on the escaped spelling is deliberate: it is what Telegram receives.

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

const SNAPSHOT: EcosystemSnapshot = {
  agents_total: 8,
  events_total: 14821,
  approvals_pending: 0,
  parsed_at: '2026-09-24T08:00:00Z',
};

/** A reader that answers whatever the test names, including a refusal. */
function fixedReader(opts: {
  active?: SourceResult<ActiveTask>;
  backlog?: SourceResult<BacklogItem>;
}): IWorkItemsReader {
  const empty = { ok: true as const, items: [], total: 0, truncated: false };
  return {
    readActiveTasks: () => Promise.resolve(opts.active ?? empty),
    readBacklogTopN: () => Promise.resolve(opts.backlog ?? empty),
    readCompletedToday: () => Promise.resolve(empty),
    readArchivedToday: () => Promise.resolve(empty),
  };
}

/** The real reader over the fixture board — the end-to-end path of the section. */
function liveReader(): IWorkItemsReader {
  return new MuneralWorkItemsReader(stubMuneraClient(), { timeZone: 'Europe/Istanbul' });
}

describe('BriefingAggregator', () => {
  it('produces all three sections from Muneral', async () => {
    const agg = new BriefingAggregator(stubOps(SNAPSHOT), liveReader());
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });

    expect(out.sections).toEqual(['ecosystem_snapshot', 'active_tasks', 'backlog_top_n']);
    expect(out.text).toContain('Утренний брифинг');
    expect(out.text).toContain('8 агентов');
    expect(out.text).toContain('A2\\-281');
    expect(out.text).toContain('A2\\-261');
    expect(out.text).not.toContain('источник недоступен');
  });

  it('says «нет» only when Muneral answered and the board is empty', async () => {
    const agg = new BriefingAggregator(
      stubOps(SNAPSHOT),
      fixedReader({ active: { ok: true, items: [], total: 0, truncated: false } }),
    );
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(out.text).toContain('Активные задачи:');
    expect(out.text).toContain('нет');
    expect(out.text).not.toContain('⚠️');
  });

  /**
   * A2-281 — the whole card in one assertion. The degraded marker must NAME the
   * cause: «⚠️ источник недоступен» was printed every day for eight days and
   * told nobody that the directory behind it had been empty since INFRA-0417.
   */
  it('names the cause when Muneral refuses, and never renders it as «нет»', async () => {
    const agg = new BriefingAggregator(
      stubOps(SNAPSHOT),
      fixedReader({
        active: { ok: false, reason: 'HTTP 403' },
        backlog: { ok: false, reason: 'ключ не настроен (MUNERAL_AGENT_KEY_FILE)' },
      }),
    );
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });

    expect(out.text).toContain('HTTP 403');
    expect(out.text).toContain('ключ не настроен');
    expect(out.text).toContain('Muneral недоступен');
    // The honest-empty words must not appear for a source that did not answer.
    expect(out.text).not.toMatch(/Активные задачи:.*нет/);
    expect(out.text).not.toMatch(/Backlog.*пусто/);
  });

  it('counts beyond the listed ids instead of pretending the list is the total', async () => {
    const many: ActiveTask[] = Array.from({ length: 12 }, (_, i) => ({
      id: `A2-${300 + i}`,
      title: 't',
      priority: 'P1',
      status: 'in_progress',
    }));
    const agg = new BriefingAggregator(
      stubOps(SNAPSHOT),
      fixedReader({ active: { ok: true, items: many, total: 12, truncated: false } }),
    );
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(out.text).toContain('A2\\-309');
    expect(out.text).toContain('ещё 2');
  });

  it('says so when the top-N came out of an incomplete page', async () => {
    const agg = new BriefingAggregator(
      stubOps(SNAPSHOT),
      fixedReader({
        backlog: {
          ok: true,
          items: [{ id: 'A2-261', title: 't', priority: 'P0' }],
          total: 1,
          truncated: true,
        },
      }),
    );
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(out.text).toContain('выборка неполная');
  });

  it('keeps the ops-bot snapshot failure separate from the Muneral one', async () => {
    const agg = new BriefingAggregator(stubOps(new Error('boom')), liveReader());
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(out.text).toContain('snapshot недоступен');
    expect(out.text).toContain('A2\\-281');
  });

  it('omits the sections the config switches off', async () => {
    const config = {
      ...baseProactiveConfig,
      channels: {
        ...baseProactiveConfig.channels,
        briefing: {
          ...baseProactiveConfig.channels.briefing,
          include_active_tasks: false,
          include_backlog_top_n: 0,
          include_ecosystem_snapshot: false,
        },
      },
    };
    const agg = new BriefingAggregator(stubOps(SNAPSHOT), liveReader());
    const out = await agg.compose({ runDate: RUN_DATE, config });
    expect(out.sections).toEqual([]);
  });
});
