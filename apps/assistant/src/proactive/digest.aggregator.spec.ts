import { describe, expect, it } from 'vitest';

import { stubMuneraClient } from './__fixtures__/muneral-responses.js';
import { baseProactiveConfig } from './__fixtures__/proactive-config.fixture.js';
import { DigestAggregator } from './digest.aggregator.js';
import { MuneralWorkItemsReader } from './muneral-reader.service.js';
import type { CompletedTask } from './proactive.types.js';
import type { DailySummaryResult, IWorkItemsReader, SourceResult } from './work-items.reader.js';

const RUN_DATE = '2026-09-24';

// MarkdownV2 escapes `-`, so a reference reads `A2\-276` in the wire text.
function fixedReader(opts: {
  completed?: SourceResult<CompletedTask>;
  summary?: DailySummaryResult;
}): IWorkItemsReader {
  const empty = { ok: true as const, items: [], total: 0, truncated: false };
  return {
    readDailySummary: () =>
      Promise.resolve(
        opts.summary ?? { ok: true, projects: [], total: 0, received: 0, truncated: false },
      ),
    readActiveTasks: () => Promise.resolve(empty),
    readBacklogTopN: () => Promise.resolve(empty),
    readCompletedToday: () => Promise.resolve(opts.completed ?? empty),
    readArchivedToday: () => Promise.resolve(empty),
  };
}

function liveReader(): IWorkItemsReader {
  return new MuneralWorkItemsReader(stubMuneraClient(), { timeZone: 'Europe/Istanbul' });
}

describe('DigestAggregator', () => {
  it('reports what reached done inside the local day, with titles', async () => {
    const agg = new DigestAggregator(liveReader());
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });

    expect(out.sections).toEqual([
      'daily_summary',
      'completed_today',
      'archived_today',
      'backlog_tomorrow',
    ]);
    expect(out.text).toContain('Сводка Muneral за 2026\\-09\\-24 \\(Europe/Istanbul\\)');
    expect(out.text).toContain('Collective mailbox opened/done today: NOT\\_MEASURED');
    expect(out.text).toContain('A2\\-276');
    expect(out.text).toContain('ARAS читает расписки');
    // Finished at 23:00 local on the 23rd — yesterday's work, not today's.
    expect(out.text).not.toContain('A2\\-269');
  });

  it('renders the archive section from Muneral status archived', async () => {
    const agg = new DigestAggregator(liveReader());
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(out.text).toContain('Архив сегодня');
    expect(out.text).toContain('A2\\-240');
  });

  it('says «нет» only when Muneral answered and nothing finished', async () => {
    const agg = new DigestAggregator(fixedReader({}));
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(out.text).toContain('Завершено сегодня');
    expect(out.text).toContain('— нет');
    expect(out.text).not.toContain('⚠️');
  });

  it('labels current per-project status counts and states that they are not transitions', async () => {
    const agg = new DigestAggregator(
      fixedReader({
        summary: {
          ok: true,
          projects: [
            { projectId: 'project-1', done: 2, inProgress: 1, review: 3, cancelled: 0, created: 1 },
          ],
          total: 7,
          received: 7,
          truncated: false,
        },
      }),
    );
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(out.text).toContain(
      'project\\-1: done 2, started \\(currently in\\_progress\\) 1, review 3, cancelled 0, new 1',
    );
    expect(out.text).toContain('это не журнал переходов');
  });

  it('keeps an unsupported daily summary visible as unavailable', async () => {
    const out = await new DigestAggregator(
      fixedReader({ summary: { ok: false, reason: 'HTTP 403' } }),
    ).compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(out.text).toContain('HTTP 403');
    expect(out.text).toContain('Collective mailbox opened/done today: NOT\\_MEASURED');
  });

  it('states the priority filter and both complete and partial queue totals', async () => {
    const complete = await new DigestAggregator({
      ...fixedReader({}),
      readBacklogTopN: () =>
        Promise.resolve({
          ok: true,
          items: [{ id: 'A2-1', title: 'one', priority: 'P0' }],
          total: 1,
          sourceTotal: 4,
          truncated: false,
        }),
    }).compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(complete.text).toContain('P0/P1: показано 1 из 1 совпадений среди 4 задач todo');

    const partialResult = await new DigestAggregator({
      ...fixedReader({}),
      readBacklogTopN: () =>
        Promise.resolve({
          ok: true,
          items: [{ id: 'A2-1', title: 'one', priority: 'P0' }],
          total: 2,
          sourceTotal: 205,
          truncated: true,
        }),
    }).compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(partialResult.text).toContain('показано 1; найдено не менее 2, всего todo: 205');
    expect(partialResult.text).toContain('выборка неполная');
  });

  it('shows a title alone when no authorized human task reference exists', async () => {
    const out = await new DigestAggregator(
      fixedReader({
        completed: {
          ok: true,
          items: [{ title: 'A title without a task number' }],
          total: 1,
          truncated: false,
        },
      }),
    ).compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(out.text).toContain('A title without a task number');
    expect(out.text).not.toContain('undefined');
    expect(out.text).not.toContain('ffffffff');
  });

  it('names the cause when Muneral refuses, instead of «нет»', async () => {
    const agg = new DigestAggregator(fixedReader({ completed: { ok: false, reason: 'HTTP 403' } }));
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(out.text).toContain('Muneral недоступен');
    expect(out.text).toContain('HTTP 403');
    expect(out.text).not.toMatch(/Завершено сегодня\n— нет/);
  });

  /**
   * A2-281 — the ARCA-0163 staleness banner is gone on purpose: it measured the
   * mtime of a Markdown file against an rsync interval, and there is neither a
   * file nor an rsync any more. The test pins its absence so a revert has to be
   * deliberate.
   */
  it('no longer prints a KB-staleness banner', async () => {
    const agg = new DigestAggregator(liveReader());
    const out = await agg.compose({ runDate: RUN_DATE, config: baseProactiveConfig });
    expect(out.text).not.toContain('KB устарел');
  });

  it('omits the archive section when the config switches it off', async () => {
    const config = {
      ...baseProactiveConfig,
      channels: {
        ...baseProactiveConfig.channels,
        digest: { ...baseProactiveConfig.channels.digest, include_archived_items: false },
      },
    };
    const out = await new DigestAggregator(liveReader()).compose({ runDate: RUN_DATE, config });
    expect(out.sections).toEqual(['daily_summary', 'completed_today', 'backlog_tomorrow']);
  });
});
