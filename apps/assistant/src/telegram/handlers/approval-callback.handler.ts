import { Inject, Injectable, Logger } from '@nestjs/common';

import { TELEGRAM_GATEWAY, type TelegramGateway } from '../../webhook/telegram.gateway.js';
import { OrchestratorService } from '../../orchestrator/orchestrator.service.js';
import { ApprovalService } from '../../approval/approval.service.js';
import {
  CallbackParseError,
  parseApprovalCallback,
} from '../../approval/telegram-callback.parser.js';

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  data?: string;
  message?: { chat: { id: number }; message_id: number };
}

const TOOL_NAME_TO_INTENT: Record<string, string> = {
  task_create: '/task_create',
  task_update: '/task_update',
  opsbot_command: '/opsbot_command',
};

@Injectable()
export class ApprovalCallbackHandler {
  private readonly logger = new Logger(ApprovalCallbackHandler.name);

  constructor(
    @Inject(TELEGRAM_GATEWAY) private readonly telegram: TelegramGateway,
    private readonly approval: ApprovalService,
    private readonly orchestrator: OrchestratorService,
  ) {}

  async handle(query: TelegramCallbackQuery): Promise<void> {
    const data = query.data;
    if (!data) {
      this.logger.debug({ id: query.id }, 'callback_query without data — ignored');
      return;
    }
    const chatId = query.message?.chat.id;
    let decision: 'approve' | 'reject';
    let pendingId: string;
    try {
      const parsed = parseApprovalCallback(data);
      decision = parsed.decision;
      pendingId = parsed.uuid;
    } catch (err) {
      const reason = err instanceof CallbackParseError ? err.reason : 'unknown';
      this.logger.warn({ id: query.id, reason }, 'invalid approval callback data');
      await this.ackSafe(query.id, 'Невалидная кнопка');
      return;
    }
    try {
      const result = await this.approval.claim(pendingId, decision, String(query.from.id));
      await this.dispatch(query, chatId, decision, result);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'approval callback failure',
      );
      await this.ackSafe(query.id, 'Ошибка обработки');
      if (chatId !== undefined) {
        await this.replySafe(chatId, '⚠️ Не удалось обработать выбор. Попробуй позже.');
      }
    }
  }

  private async dispatch(
    query: TelegramCallbackQuery,
    chatId: number | undefined,
    decision: 'approve' | 'reject',
    result: Awaited<ReturnType<ApprovalService['claim']>>,
  ): Promise<void> {
    if (result.kind === 'expired') {
      await this.ackSafe(query.id, 'Истек срок');
      if (chatId !== undefined) {
        await this.replySafe(chatId, '⌛ Время ожидания подтверждения истекло.');
      }
      return;
    }
    if (result.kind === 'already_decided') {
      await this.ackSafe(query.id, 'Уже принято');
      if (chatId !== undefined) {
        await this.replySafe(chatId, 'ℹ️ Этот выбор уже был принят ранее.');
      }
      return;
    }
    if (result.kind === 'rejected' || decision === 'reject') {
      await this.ackSafe(query.id, 'Отклонено');
      if (chatId !== undefined) {
        await this.replySafe(chatId, '✗ Действие отклонено.');
      }
      return;
    }
    await this.ackSafe(query.id, 'Принято');
    const intent = lookupIntent(result.envelope);
    const payload = lookupPayload(result.envelope);
    if (!intent || payload === undefined) {
      this.logger.warn(
        { envelope: result.envelope },
        'approved envelope missing tool_name/payload',
      );
      if (chatId !== undefined) {
        await this.replySafe(chatId, '⚠️ Не удалось выполнить действие (нет данных).');
      }
      return;
    }
    let response: unknown;
    try {
      response = await this.orchestrator.route(intent, payload);
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), intent },
        'approved orchestrator route failed',
      );
      if (chatId !== undefined) {
        await this.replySafe(chatId, '⚠️ Действие подтверждено, но выполнить не удалось.');
      }
      return;
    }
    if (chatId !== undefined) {
      await this.replySafe(chatId, renderResponse(intent, response));
    }
  }

  private async ackSafe(callbackId: string, text?: string): Promise<void> {
    try {
      await this.telegram.answerCallbackQuery(callbackId, text);
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'answerCallbackQuery failed (non-fatal)',
      );
    }
  }

  private async replySafe(chatId: number, text: string): Promise<void> {
    try {
      await this.telegram.sendMessage(chatId, text);
    } catch (err) {
      this.logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'callback reply failed',
      );
    }
  }
}

function lookupIntent(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const toolName = (envelope as { tool_name?: unknown }).tool_name;
  if (typeof toolName !== 'string') return null;
  return TOOL_NAME_TO_INTENT[toolName] ?? `/${toolName}`;
}

function lookupPayload(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== 'object') return undefined;
  return (envelope as { payload?: unknown }).payload;
}

function renderResponse(intent: string, response: unknown): string {
  if (response && typeof response === 'object' && 'kind' in response) {
    const r = response as {
      kind: string;
      task?: { title?: string; id?: string };
      reason?: string;
      detail?: string;
      command_id?: string;
      result?: { echo?: { token?: string } };
    };
    if (r.kind === 'ok') {
      if (intent === '/task_create' && r.task) {
        return `✓ Задача создана: «${r.task.title ?? ''}» (id ${r.task.id ?? '?'}).`;
      }
      return '✓ Действие выполнено.';
    }
    if (r.kind === 'unavailable') {
      const det = r.detail ? ` — ${r.detail}` : '';
      return `⚠️ Действие не выполнено (${r.reason ?? 'unavailable'})${det}.`;
    }
    if (r.kind === 'command_ok') {
      const echoToken = r.result?.echo?.token;
      if (intent === '/opsbot_command' && typeof echoToken === 'string') {
        return `✓ Ops Bot echo: «${echoToken}» (id ${r.command_id ?? '?'}).`;
      }
      return `✓ Команда выполнена (id ${r.command_id ?? '?'}).`;
    }
    if (r.kind === 'command_failed') {
      const det = r.detail ? ` — ${r.detail}` : '';
      const cmd = intent === '/opsbot_command' ? 'echo-back' : 'команда';
      return `⚠️ Команда «${cmd}» не выполнена (${r.reason ?? 'failed'})${det}.`;
    }
  }
  return '✓ Действие выполнено.';
}
