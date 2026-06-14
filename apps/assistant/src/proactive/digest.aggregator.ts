import { Injectable } from '@nestjs/common';

import { DatarimReaderService } from './datarim-reader.service.js';
import { escapeMd, bold } from './markdown-v2.js';
import type {
  ArchivedItem,
  BacklogItem,
  ComposedMessage,
  CompletedTask,
  ProactiveConfig,
} from './proactive.types.js';

export interface DigestInput {
  runDate: string;
  config: ProactiveConfig;
}

@Injectable()
export class DigestAggregator {
  constructor(private readonly datarim: DatarimReaderService) {}

  async compose(input: DigestInput): Promise<ComposedMessage> {
    const { runDate, config } = input;
    const ch = config.channels.digest;
    const sections: string[] = [];
    const lines: string[] = [`🌙 ${bold(`Дайджест ${runDate}`)}`];

    // ARCA-0154: probe datarim source once. Unmounted/ENOENT → degraded marker
    // for every section instead of an honest-empty "— нет".
    const sourceAvailable = await this.datarim.sourceAvailable();

    // ARCA-0163: KB staleness guard. Warn when rsync gap has left KB stale.
    // Does not replace the degraded marker for a missing mount — it is an
    // additional check for a present-but-stale source.
    if (sourceAvailable) {
      const freshness = await this.datarim.kbFreshness();
      if (freshness.stale) {
        const lastTime = new Date(freshness.lastSyncIso).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Istanbul',
        });
        const ageStr =
          freshness.ageHours === Infinity
            ? 'неизвестно'
            : `${Math.round(freshness.ageHours)}ч`;
        lines.push('');
        lines.push(escapeMd(`⚠️ KB устарел (last sync ${lastTime}, ${ageStr} назад)`));
      }
    }

    if (ch.include_completed_tasks) {
      const completed = await this.datarim.readCompletedToday(runDate);
      sections.push('completed_today');
      lines.push('');
      lines.push(this.renderCompleted(completed, sourceAvailable));
    }

    if (ch.include_archived_items) {
      const archived = await this.datarim.readArchivedToday(runDate);
      sections.push('archived_today');
      lines.push('');
      lines.push(this.renderArchived(archived, sourceAvailable));
    }

    {
      const top = await this.datarim.readBacklogTopN(3);
      sections.push('backlog_tomorrow');
      lines.push('');
      lines.push(this.renderBacklog(top, sourceAvailable));
    }

    return { text: lines.join('\n'), sections };
  }

  private renderCompleted(items: readonly CompletedTask[], sourceAvailable: boolean): string {
    const header = bold('Завершено сегодня');
    if (!sourceAvailable) return `${header}\n${escapeMd('— ⚠️ источник недоступен')}`;
    if (items.length === 0) return `${header}\n${escapeMd('— нет')}`;
    const body = items.map((c) => `\\- ${escapeMd(c.id)}: ${escapeMd(c.title)}`).join('\n');
    return `${header}\n${body}`;
  }

  private renderArchived(items: readonly ArchivedItem[], sourceAvailable: boolean): string {
    const header = bold('Архив сегодня');
    if (!sourceAvailable) return `${header}\n${escapeMd('— ⚠️ источник недоступен')}`;
    if (items.length === 0) return `${header}\n${escapeMd('— нет')}`;
    const body = items.map((a) => `\\- ${escapeMd(a.id)} \\(${escapeMd(a.subdir)}\\)`).join('\n');
    return `${header}\n${body}`;
  }

  private renderBacklog(items: readonly BacklogItem[], sourceAvailable: boolean): string {
    const header = bold('В очереди на завтра');
    if (!sourceAvailable) return `${header}\n${escapeMd('— ⚠️ источник недоступен')}`;
    if (items.length === 0) return `${header}\n${escapeMd('— пусто')}`;
    const body = items
      .map(
        (b) =>
          `\\- ${escapeMd(b.id)} \\(${escapeMd(b.priority)}/${escapeMd(b.complexity)}\\): ${escapeMd(b.title)}`,
      )
      .join('\n');
    return `${header}\n${body}`;
  }
}
