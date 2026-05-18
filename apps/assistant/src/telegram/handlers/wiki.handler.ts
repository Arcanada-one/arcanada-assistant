import { Inject, Injectable, Logger } from '@nestjs/common';

import { TELEGRAM_GATEWAY, type TelegramGateway } from '../../webhook/telegram.gateway.js';
import {
  NoAgentForIntentError,
  OrchestratorService,
} from '../../orchestrator/orchestrator.service.js';
import type { KnowledgeAgentResult } from '../../agents/knowledge-agent/knowledge-agent.service.js';

const SNIPPET_MAX_LEN = 240;

@Injectable()
export class WikiHandler {
  private readonly logger = new Logger(WikiHandler.name);

  constructor(
    private readonly orchestrator: OrchestratorService,
    @Inject(TELEGRAM_GATEWAY) private readonly telegram: TelegramGateway,
  ) {}

  async handle(chatId: number, query: string): Promise<void> {
    let text: string;
    try {
      const result = await this.orchestrator.route<KnowledgeAgentResult>('/wiki', { query });
      text = render(result);
    } catch (err) {
      if (err instanceof NoAgentForIntentError) {
        text = '⚠️ Команда /wiki временно отключена.';
      } else {
        this.logger.warn({ err: errMsg(err) }, '/wiki orchestrator failure');
        text = '⚠️ Не удалось выполнить поиск по вики. Попробуй позже.';
      }
    }
    try {
      await this.telegram.sendMessage(chatId, text);
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, '/wiki reply failed');
    }
  }
}

function render(result: KnowledgeAgentResult): string {
  if (result.kind === 'unavailable') {
    return `⚠️ Поиск по вики недоступен (${result.reason}). Попробуй позже.`;
  }
  if (result.kind === 'text') {
    return result.text;
  }
  if (result.kind !== 'wiki_hits') {
    return '⚠️ Неожиданный ответ от knowledge-agent.';
  }
  const lines = [
    `🔍 Поиск по вики: «${result.query}» (${result.searchTimeMs.toFixed(0)} мс)`,
    '',
    ...result.hits.map((hit, i) => {
      const snippet =
        hit.content.length > SNIPPET_MAX_LEN
          ? `${hit.content.slice(0, SNIPPET_MAX_LEN)}…`
          : hit.content;
      const heading = hit.heading ? `\n  ↳ ${hit.heading}` : '';
      return `${i + 1}. ${snippet}${heading}\n  📎 ${hit.sourcePath} · score ${(hit.score * 100).toFixed(0)}%`;
    }),
  ];
  return lines.join('\n');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
