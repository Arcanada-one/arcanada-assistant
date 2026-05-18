import { Inject, Injectable, Logger } from '@nestjs/common';

import { TELEGRAM_GATEWAY, type TelegramGateway } from '../../webhook/telegram.gateway.js';
import {
  NoAgentForIntentError,
  OrchestratorService,
} from '../../orchestrator/orchestrator.service.js';
import type { KnowledgeAgentResult } from '../../agents/knowledge-agent/knowledge-agent.service.js';

@Injectable()
export class RememberHandler {
  private readonly logger = new Logger(RememberHandler.name);

  constructor(
    private readonly orchestrator: OrchestratorService,
    @Inject(TELEGRAM_GATEWAY) private readonly telegram: TelegramGateway,
  ) {}

  /**
   * Handles `/remember <text>` and the natural-language trigger «запомни, что …».
   * `userId` is server-derived from Telegram message.from.id and used as LTM
   * namespace component (see `KnowledgeAgentService.handleRemember`).
   */
  async handle(chatId: number, userId: number | undefined, text: string): Promise<void> {
    const fact = text.trim();
    let reply: string;
    if (userId === undefined) {
      reply = '⚠️ Не удалось определить пользователя — невозможно сохранить в память.';
    } else if (!fact) {
      reply = 'Что запомнить? Используй: /remember <текст> или «запомни, что …».';
    } else {
      try {
        const result = await this.orchestrator.route<KnowledgeAgentResult>('/remember', {
          text: fact,
          userId,
        });
        reply = render(result);
      } catch (err) {
        if (err instanceof NoAgentForIntentError) {
          reply = '⚠️ Команда /remember временно отключена.';
        } else {
          this.logger.warn({ err: errMsg(err) }, '/remember orchestrator failure');
          reply = '⚠️ Не удалось сохранить в память. Попробуй позже.';
        }
      }
    }
    try {
      await this.telegram.sendMessage(chatId, reply);
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, '/remember reply failed');
    }
  }
}

function render(result: KnowledgeAgentResult): string {
  if (result.kind === 'unavailable') {
    return `⚠️ Не удалось запомнить (${result.reason}). Попробуй позже.`;
  }
  if (result.kind === 'text') {
    return result.text;
  }
  if (result.kind !== 'remembered') {
    return '⚠️ Неожиданный ответ от knowledge-agent.';
  }
  const note = result.async ? ' (фоновая запись — chunk появится через несколько секунд)' : '';
  return `🧠 Запомнил! Сохранил в namespace ${result.namespace}.${note}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
