import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EcosystemSnapshot, IOpsBotClient } from '@arcanada/core';

import { OPS_BOT_CLIENT } from '../agents/ops-agent/ops-agent.service.js';

import { escapeMd, bold } from './markdown-v2.js';
import type {
  ActiveTask,
  BacklogItem,
  ComposedMessage,
  ProactiveConfig,
} from './proactive.types.js';
import {
  WORK_ITEMS_READER,
  type IWorkItemsReader,
  type SourceResult,
} from './work-items.reader.js';

export interface BriefingInput {
  runDate: string;
  config: ProactiveConfig;
}

/** How many ids a section names before it stops listing and only counts. */
const MAX_LISTED_IDS = 10;

@Injectable()
export class BriefingAggregator {
  private readonly logger = new Logger(BriefingAggregator.name);

  constructor(
    @Inject(OPS_BOT_CLIENT) private readonly opsBot: IOpsBotClient,
    @Inject(WORK_ITEMS_READER) private readonly workItems: IWorkItemsReader,
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
      const active = await this.workItems.readActiveTasks();
      sections.push('active_tasks');
      lines.push('');
      lines.push(this.renderActiveTasks(active));
    }

    if (ch.include_backlog_top_n > 0) {
      const top = await this.workItems.readBacklogTopN(ch.include_backlog_top_n);
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
    if (!snap) return `${bold('Сервисы:')} ${escapeMd('⚠️ snapshot недоступен')}`;
    const events = String(snap.events_total);
    return [
      `${bold('Сервисы:')} ${escapeMd(`${snap.agents_total} агентов, ${events} событий, approvals ${snap.approvals_pending}`)}`,
    ].join('\n');
  }

  private renderActiveTasks(result: SourceResult<ActiveTask>): string {
    const header = bold('Активные задачи:');
    if (!result.ok) return `${header} ${degraded(result.reason)}`;
    if (result.total === 0) return `${header} ${escapeMd('нет')}`;
    const shown = result.items.slice(0, MAX_LISTED_IDS);
    const ids = shown.map((t) => escapeMd(t.id)).join(', ');
    const more =
      result.total > shown.length ? escapeMd(`, …ещё ${result.total - shown.length}`) : '';
    return `${header} ${escapeMd(String(result.total))} \\(${ids}${more}\\)`;
  }

  private renderBacklog(result: SourceResult<BacklogItem>, requested: number): string {
    const header = bold(`Backlog top-${requested} P0/P1:`);
    if (!result.ok) return `${header} ${degraded(result.reason)}`;
    if (result.items.length === 0) return `${header} ${escapeMd('пусто')}`;
    const ids = result.items.map((b) => escapeMd(b.id)).join(', ');
    return `${header} ${ids}${partial(result.truncated)}`;
  }
}

/**
 * A2-281 — the degraded marker NAMES THE CAUSE. «⚠️ источник недоступен» was
 * true and useless: it was printed for 8 days straight without telling anyone
 * that the directory behind it had been empty since INFRA-0417.
 */
export function degraded(reason: string): string {
  return escapeMd(`⚠️ Muneral недоступен: ${reason}`);
}

/** Said out loud when a top-N was picked from a page that did not hold everything. */
export function partial(truncated: boolean): string {
  return truncated ? ` ${escapeMd('(выборка неполная)')}` : '';
}
