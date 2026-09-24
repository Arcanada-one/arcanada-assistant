import { Inject, Injectable } from '@nestjs/common';

import { degraded, partial } from './briefing.aggregator.js';
import { escapeMd, bold } from './markdown-v2.js';
import type {
  ArchivedItem,
  BacklogItem,
  ComposedMessage,
  CompletedTask,
  ProactiveConfig,
} from './proactive.types.js';
import { WORK_ITEMS_READER, type IWorkItemsReader, type SourceResult } from './work-items.reader.js';

export interface DigestInput {
  runDate: string;
  config: ProactiveConfig;
}

/** How many queued items the digest names for tomorrow. */
const BACKLOG_TOMORROW_N = 3;

@Injectable()
export class DigestAggregator {
  constructor(@Inject(WORK_ITEMS_READER) private readonly workItems: IWorkItemsReader) {}

  async compose(input: DigestInput): Promise<ComposedMessage> {
    const { runDate, config } = input;
    const ch = config.channels.digest;
    const sections: string[] = [];
    const lines: string[] = [`🌙 ${bold(`Дайджест ${runDate}`)}`];

    // A2-281 — the ARCA-0163 KB-staleness warning is gone with the file feed it
    // measured. It compared the mtime of `tasks.md` against the hourly rsync
    // interval; there is no file and no rsync any more, and a staleness check
    // over an API that answers in real time has nothing to measure. Muneral
    // being unreachable is reported per section, by the section, with its cause.

    if (ch.include_completed_tasks) {
      const completed = await this.workItems.readCompletedToday(runDate);
      sections.push('completed_today');
      lines.push('');
      lines.push(this.renderCompleted(completed));
    }

    if (ch.include_archived_items) {
      const archived = await this.workItems.readArchivedToday(runDate);
      sections.push('archived_today');
      lines.push('');
      lines.push(this.renderArchived(archived));
    }

    {
      const top = await this.workItems.readBacklogTopN(BACKLOG_TOMORROW_N);
      sections.push('backlog_tomorrow');
      lines.push('');
      lines.push(this.renderBacklog(top));
    }

    return { text: lines.join('\n'), sections };
  }

  private renderCompleted(result: SourceResult<CompletedTask>): string {
    const header = bold('Завершено сегодня');
    if (!result.ok) return `${header}\n${escapeMd('— ')}${degraded(result.reason)}`;
    if (result.items.length === 0) return `${header}\n${escapeMd('— нет')}`;
    const body = result.items.map((c) => `\\- ${escapeMd(c.id)}: ${escapeMd(c.title)}`).join('\n');
    return `${header}\n${body}${partial(result.truncated)}`;
  }

  private renderArchived(result: SourceResult<ArchivedItem>): string {
    const header = bold('Архив сегодня');
    if (!result.ok) return `${header}\n${escapeMd('— ')}${degraded(result.reason)}`;
    if (result.items.length === 0) return `${header}\n${escapeMd('— нет')}`;
    const body = result.items.map((a) => `\\- ${escapeMd(a.id)}: ${escapeMd(a.title)}`).join('\n');
    return `${header}\n${body}${partial(result.truncated)}`;
  }

  private renderBacklog(result: SourceResult<BacklogItem>): string {
    const header = bold('В очереди на завтра');
    if (!result.ok) return `${header}\n${escapeMd('— ')}${degraded(result.reason)}`;
    if (result.items.length === 0) return `${header}\n${escapeMd('— пусто')}`;
    const body = result.items
      .map((b) => `\\- ${escapeMd(b.id)} \\(${escapeMd(b.priority)}\\): ${escapeMd(b.title)}`)
      .join('\n');
    return `${header}\n${body}${partial(result.truncated)}`;
  }
}
