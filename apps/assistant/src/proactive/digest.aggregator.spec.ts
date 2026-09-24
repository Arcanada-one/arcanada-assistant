import { describe, expect, it } from 'vitest';

import { stubMuneraClient } from './__fixtures__/muneral-responses.js';
import { baseProactiveConfig } from './__fixtures__/proactive-config.fixture.js';
import { DigestAggregator } from './digest.aggregator.js';
import { MuneralWorkItemsReader } from './muneral-reader.service.js';
import type { CompletedTask } from './proactive.types.js';
import type { IWorkItemsReader, SourceResult } from './work-items.reader.js';

const RUN_DATE = '2026-09-24';

// MarkdownV2 escapes `-`, so a reference reads `A2\-276` in the wire text.
function fixedReader(opts: { completed?: SourceResult<CompletedTask> }): IWorkItemsReader {
  const empty = { ok: true as const, items: [], total: 0, truncated: false };
  return {
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

    expect(out.sections).toEqual(['completed_today', 'archived_today', 'backlog_tomorrow']);
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
    expect(out.sections).toEqual(['completed_today', 'backlog_tomorrow']);
  });
});
