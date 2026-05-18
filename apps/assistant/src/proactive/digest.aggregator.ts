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

    if (ch.include_completed_tasks) {
      const completed = await this.datarim.readCompletedToday(runDate);
      sections.push('completed_today');
      lines.push('');
      lines.push(this.renderCompleted(completed));
    }

    if (ch.include_archived_items) {
      const archived = await this.datarim.readArchivedToday(runDate);
      sections.push('archived_today');
      lines.push('');
      lines.push(this.renderArchived(archived));
    }

    {
      const top = await this.datarim.readBacklogTopN(3);
      sections.push('backlog_tomorrow');
      lines.push('');
      lines.push(this.renderBacklog(top));
    }

    return { text: lines.join('\n'), sections };
  }

  private renderCompleted(items: readonly CompletedTask[]): string {
    const header = bold('Завершено сегодня');
    if (items.length === 0) return `${header}\n${escapeMd('— нет')}`;
    const body = items.map((c) => `\\- ${escapeMd(c.id)}: ${escapeMd(c.title)}`).join('\n');
    return `${header}\n${body}`;
  }

  private renderArchived(items: readonly ArchivedItem[]): string {
    const header = bold('Архив сегодня');
    if (items.length === 0) return `${header}\n${escapeMd('— нет')}`;
    const body = items.map((a) => `\\- ${escapeMd(a.id)} \\(${escapeMd(a.subdir)}\\)`).join('\n');
    return `${header}\n${body}`;
  }

  private renderBacklog(items: readonly BacklogItem[]): string {
    const header = bold('В очереди на завтра');
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
