import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EcosystemSnapshot, IOpsBotClient } from '@arcanada/core';

import { OPS_BOT_CLIENT } from '../agents/ops-agent/ops-agent.service.js';

import { DatarimReaderService } from './datarim-reader.service.js';
import { escapeMd, bold } from './markdown-v2.js';
import type {
  ActiveTask,
  BacklogItem,
  ComposedMessage,
  ProactiveConfig,
} from './proactive.types.js';

export interface BriefingInput {
  runDate: string;
  config: ProactiveConfig;
}

@Injectable()
export class BriefingAggregator {
  private readonly logger = new Logger(BriefingAggregator.name);

  constructor(
    @Inject(OPS_BOT_CLIENT) private readonly opsBot: IOpsBotClient,
    private readonly datarim: DatarimReaderService,
  ) {}

  async compose(input: BriefingInput): Promise<ComposedMessage> {
    const { runDate, config } = input;
    const ch = config.channels.briefing;
    const sections: string[] = [];
    const lines: string[] = [`🌅 ${bold(`Утренний брифинг ${runDate}`)}`];

    if (ch.include_ecosystem_snapshot) {
      const snap = await this.safeSnapshot();
      sections.push('ecosystem_snapshot');
      lines.push('');
      lines.push(this.renderSnapshot(snap));
    }

    if (ch.include_active_tasks) {
      const tasks = await this.datarim.readActiveTasks();
      sections.push('active_tasks');
      lines.push('');
      lines.push(this.renderActiveTasks(tasks));
    }

    if (ch.include_backlog_top_n > 0) {
      const top = await this.datarim.readBacklogTopN(ch.include_backlog_top_n);
      sections.push('backlog_top_n');
      lines.push('');
      lines.push(this.renderBacklog(top, ch.include_backlog_top_n));
    }

    return { text: lines.join('\n'), sections };
  }

  private async safeSnapshot(): Promise<EcosystemSnapshot | null> {
    try {
      return await this.opsBot.getEcosystemSnapshot();
    } catch (err) {
      this.logger.warn(`ecosystem snapshot fetch failed: ${(err as Error).message}`);
      return null;
    }
  }

  private renderSnapshot(snap: EcosystemSnapshot | null): string {
    if (!snap) return `${bold('Сервисы:')} ${escapeMd('snapshot недоступен')}`;
    const events = String(snap.events_total);
    return [
      `${bold('Сервисы:')} ${escapeMd(`${snap.agents_total} агентов, ${events} событий, approvals ${snap.approvals_pending}`)}`,
    ].join('\n');
  }

  private renderActiveTasks(tasks: readonly ActiveTask[]): string {
    if (tasks.length === 0) return `${bold('Активные задачи:')} ${escapeMd('нет')}`;
    const ids = tasks.map((t) => escapeMd(t.id)).join(', ');
    return `${bold('Активные задачи:')} ${escapeMd(`${tasks.length}`)} \\(${ids}\\)`;
  }

  private renderBacklog(items: readonly BacklogItem[], requested: number): string {
    if (items.length === 0)
      return `${bold(`Backlog top-${requested} P0/P1:`)} ${escapeMd('пусто')}`;
    const ids = items.map((b) => escapeMd(b.id)).join(', ');
    return `${bold(`Backlog top-${requested} P0/P1:`)} ${ids}`;
  }
}
