import { Inject, Injectable, Logger } from '@nestjs/common';

import { TELEGRAM_GATEWAY, type TelegramGateway } from '../../webhook/telegram.gateway.js';
import { OrchestratorService } from '../../orchestrator/orchestrator.service.js';
import { ApprovalService } from '../../approval/approval.service.js';
import type { TaskResult } from '../../agents/munera/munera.schemas.js';

export const MUNERA_DEFAULT_PROJECT_ID = Symbol.for('MUNERA_DEFAULT_PROJECT_ID');

const TITLE_MAX_LEN = 500;
const NL_PREFIX = /^создай(те)?\s+задачу[:\s]+/iu;

@Injectable()
export class TaskHandler {
  private readonly logger = new Logger(TaskHandler.name);

  constructor(
    @Inject(TELEGRAM_GATEWAY) private readonly telegram: TelegramGateway,
    private readonly approval: ApprovalService,
    private readonly orchestrator: OrchestratorService,
    @Inject(MUNERA_DEFAULT_PROJECT_ID) private readonly defaultProjectId: string | undefined,
  ) {}

  static parseNL(text: string): string | null {
    const match = NL_PREFIX.exec(text);
    if (!match) return null;
    return text.slice(match[0].length);
  }

  async handle(chatId: number, rawTitle: string): Promise<void> {
    const title = rawTitle.trim().slice(0, TITLE_MAX_LEN);
    if (!title) {
      await this.replySafe(chatId, '⚠️ Укажи название задачи после команды.');
      return;
    }
    if (!this.defaultProjectId) {
      await this.replySafe(
        chatId,
        '⚠️ Не задан проект по умолчанию. Установите MUNERA_DEFAULT_PROJECT_ID.',
      );
      return;
    }
    const payload = { projectId: this.defaultProjectId, title };
    try {
      const outcome = await this.approval.propose('task_create', payload);
      if (outcome.kind === 'approval_required') {
        await this.telegram.sendMessageWithKeyboard(
          chatId,
          `Создать задачу «${title}»? Подтвердите выбор.`,
          [
            [
              { text: '✓ Approve', callbackData: outcome.approveCallback },
              { text: '✗ Reject', callbackData: outcome.rejectCallback },
            ],
          ],
        );
        return;
      }
      const result = await this.orchestrator.route<TaskResult>('/task_create', payload);
      await this.replySafe(chatId, renderTaskResult(result, title));
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'task handler failure');
      await this.replySafe(chatId, '⚠️ Не удалось создать задачу. Попробуй позже.');
    }
  }

  private async replySafe(chatId: number, text: string): Promise<void> {
    try {
      await this.telegram.sendMessage(chatId, text);
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'task reply failed');
    }
  }
}

function renderTaskResult(result: TaskResult, title: string): string {
  if (result.kind === 'ok') {
    return `✓ Задача создана: «${result.task.title}» (id ${result.task.id}).`;
  }
  const detail = result.detail ? ` — ${result.detail}` : '';
  return `⚠️ Не удалось создать «${title}» (${result.reason})${detail}.`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
