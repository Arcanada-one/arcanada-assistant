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
import {
  WORK_ITEMS_READER,
  type IWorkItemsReader,
  type SourceResult,
} from './work-items.reader.js';

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

    const summary = await this.workItems.readDailySummary(runDate);
    sections.push('daily_summary');
    lines.push('');
    lines.push(this.renderDailySummary(summary, runDate, config.timezone));

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
    const body = result.items.map((c) => `\\- ${formatTask(c.id, c.title)}`).join('\n');
    return `${header}\n${body}${partial(result.truncated)}`;
  }

  private renderArchived(result: SourceResult<ArchivedItem>): string {
    const header = bold('Архив сегодня');
    if (!result.ok) return `${header}\n${escapeMd('— ')}${degraded(result.reason)}`;
    if (result.items.length === 0) return `${header}\n${escapeMd('— нет')}`;
    const body = result.items.map((a) => `\\- ${formatTask(a.id, a.title)}`).join('\n');
    return `${header}\n${body}${partial(result.truncated)}`;
  }

  private renderBacklog(result: SourceResult<BacklogItem>): string {
    const header = bold('В очереди на завтра');
    if (!result.ok) return `${header}\n${escapeMd('— ')}${degraded(result.reason)}`;
    const filter = 'P0/P1';
    const count = result.truncated
      ? `показано ${result.items.length}; найдено не менее ${result.total}, всего todo: ${result.sourceTotal ?? 'NOT_MEASURED'}`
      : `показано ${result.items.length} из ${result.total} совпадений среди ${result.sourceTotal ?? result.total} задач todo`;
    const body = result.items.length
      ? result.items
          .map((b) => `\\- ${escapeMd(b.priority)}: ${formatTask(b.id, b.title)}`)
          .join('\n')
      : escapeMd('— пусто');
    return `${header}\n${escapeMd(`${filter}: ${count}`)}\n${body}${partial(result.truncated)}`;
  }

  private renderDailySummary(
    result: Awaited<ReturnType<IWorkItemsReader['readDailySummary']>>,
    runDate: string,
    timeZone: string,
  ): string {
    const header = bold(`Сводка Muneral за ${runDate} (${timeZone})`);
    if (!result.ok) {
      return `${header}\n${escapeMd('Данные недоступны: ')}${degraded(result.reason)}\n${escapeMd('Collective mailbox opened/done today: NOT_MEASURED — нет подтверждённого поддерживаемого зеркала')}`;
    }
    const rows = result.projects.length
      ? result.projects.map((p) =>
          escapeMd(`${p.projectId}: done ${p.done}, started (currently in_progress) ${p.inProgress}, review ${p.review}, cancelled ${p.cancelled}, new ${p.created}`),
        )
      : [escapeMd('нет строк')];
    const completeness = result.truncated
      ? `Частичная выборка: получено ${result.received} из ${result.total} строк.`
      : `Уникальные строки в выборке: ${result.total}.`;
    return [
      header,
      escapeMd('Семантика: текущий статус уникальных строк, обновлённых за этот день; это не журнал переходов. «new» — createdAt внутри дня среди этих строк.'),
      ...rows,
      escapeMd(completeness),
      escapeMd('Collective mailbox opened/done today: NOT_MEASURED — нет подтверждённого поддерживаемого зеркала.'),
    ].join('\n');
  }
}

function formatTask(id: string | undefined, title: string): string {
  return id ? `${escapeMd(id)}: ${escapeMd(title)}` : escapeMd(title);
}
