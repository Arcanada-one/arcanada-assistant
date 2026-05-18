import { Injectable, Logger } from '@nestjs/common';

import { BriefingAggregator } from './briefing.aggregator.js';
import { DigestAggregator } from './digest.aggregator.js';
import { ProactiveDispatcherService } from './proactive-dispatcher.service.js';
import { ProactiveConfigService } from './proactive-config.service.js';
import type { DispatchResult, ProactiveKind } from './proactive.types.js';

export interface ProcessJobInput {
  kind: ProactiveKind;
  runDate?: string;
}

@Injectable()
export class ProactiveProcessor {
  private readonly logger = new Logger(ProactiveProcessor.name);

  constructor(
    private readonly briefing: BriefingAggregator,
    private readonly digest: DigestAggregator,
    private readonly dispatcher: ProactiveDispatcherService,
    private readonly configService: ProactiveConfigService,
  ) {}

  async process(input: ProcessJobInput): Promise<DispatchResult> {
    const config = this.configService.snapshot();
    if (!config) {
      this.logger.warn(`process aborted (config not loaded yet) kind=${input.kind}`);
      return { status: 'skipped', reason: 'config-not-loaded' };
    }
    if (!config.enabled) {
      this.logger.log(`process skipped (global kill switch) kind=${input.kind}`);
      return { status: 'skipped', reason: 'globally-disabled' };
    }
    const channelEnabled =
      input.kind === 'briefing' ? config.channels.briefing.enabled : config.channels.digest.enabled;
    if (!channelEnabled) {
      this.logger.log(`process skipped (channel disabled) kind=${input.kind}`);
      return { status: 'skipped', reason: 'channel-disabled' };
    }
    const runDate = input.runDate ?? this.todayIstanbul();
    const composed =
      input.kind === 'briefing'
        ? await this.briefing.compose({ runDate, config })
        : await this.digest.compose({ runDate, config });
    const chatId =
      input.kind === 'briefing' ? config.channels.briefing.chat_id : config.channels.digest.chat_id;
    return this.dispatcher.dispatch({ kind: input.kind, text: composed.text, chatId, runDate });
  }

  private todayIstanbul(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
}
