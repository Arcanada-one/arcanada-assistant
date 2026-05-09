import { Inject, Injectable, Logger } from '@nestjs/common';

import { TELEGRAM_GATEWAY, type TelegramGateway } from '../../webhook/telegram.gateway.js';
import {
  NoAgentForIntentError,
  OrchestratorService,
} from '../../orchestrator/orchestrator.service.js';
import type { OpsAgentResult } from '../../agents/ops-agent/ops-agent.service.js';

@Injectable()
export class StatusHandler {
  private readonly logger = new Logger(StatusHandler.name);

  constructor(
    private readonly orchestrator: OrchestratorService,
    @Inject(TELEGRAM_GATEWAY) private readonly telegram: TelegramGateway,
  ) {}

  async handle(chatId: number): Promise<void> {
    let text: string;
    try {
      const result = await this.orchestrator.route<OpsAgentResult>('/status');
      text = render(result);
    } catch (err) {
      if (err instanceof NoAgentForIntentError) {
        text = '⚠️ Команда /status временно отключена.';
      } else {
        this.logger.warn({ err: errMsg(err) }, '/status orchestrator failure');
        text = '⚠️ Не удалось получить статус. Попробуй позже.';
      }
    }
    try {
      await this.telegram.sendMessage(chatId, text);
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, '/status reply failed');
    }
  }
}

function render(result: OpsAgentResult): string {
  if (result.kind === 'unavailable') {
    return '⚠️ Ops Bot недоступен (circuit breaker open). Попробуй позже.';
  }
  if (result.kind !== 'status') {
    return '⚠️ Неожиданный ответ от ops-agent.';
  }
  const s = result.snapshot;
  return [
    '🌐 Экосистема Arcanada',
    `• Агенты: ${s.agents_total}`,
    `• Событий: ${s.events_total}`,
    `• Approvals pending: ${s.approvals_pending}`,
    `Snapshot: ${s.parsed_at}`,
  ].join('\n');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
