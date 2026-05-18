import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { TELEGRAM_GATEWAY, type TelegramGateway } from '../../webhook/telegram.gateway.js';
import { ApprovalService } from '../../approval/approval.service.js';
import { OrchestratorService } from '../../orchestrator/orchestrator.service.js';
import type { OpsAgentResult } from '../../agents/ops-agent/ops-agent.service.js';

const TOOL_NAME = 'opsbot_command';
const INTENT = '/opsbot_command';
const ALLOWED_CMDS = new Set(['echo-back', 'health-probe']);

@Injectable()
export class OpsCommandHandler {
  private readonly logger = new Logger(OpsCommandHandler.name);

  constructor(
    @Inject(TELEGRAM_GATEWAY) private readonly telegram: TelegramGateway,
    private readonly approval: ApprovalService,
    private readonly orchestrator: OrchestratorService,
  ) {}

  async handle(chatId: number, rawArgs: string): Promise<void> {
    const args = rawArgs.trim();
    if (!args) {
      await this.replySafe(
        chatId,
        'ℹ️ Использование: /ops <команда> [payload]. Доступно: echo-back, health-probe.',
      );
      return;
    }
    const [cmd, ...rest] = args.split(/\s+/u);
    if (!ALLOWED_CMDS.has(cmd)) {
      await this.replySafe(
        chatId,
        `⚠️ Неизвестная команда «${cmd}». Доступно: echo-back, health-probe.`,
      );
      return;
    }
    const payload = buildPayload(cmd, rest.join(' '));
    const proposal = {
      cmd,
      payload,
      idempotencyKey: uuidv7(),
    };
    try {
      const outcome = await this.approval.propose(TOOL_NAME, proposal);
      if (outcome.kind === 'approval_required') {
        await this.telegram.sendMessageWithKeyboard(
          chatId,
          `Выполнить Ops Bot команду «${cmd}»? Подтвердите выбор.`,
          [
            [
              { text: '✓ Approve', callbackData: outcome.approveCallback },
              { text: '✗ Reject', callbackData: outcome.rejectCallback },
            ],
          ],
        );
        return;
      }
      const result = (await this.orchestrator.route(INTENT, proposal)) as OpsAgentResult;
      await this.replySafe(chatId, renderResult(cmd, result));
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'ops command failure');
      await this.replySafe(chatId, '⚠️ Не удалось выполнить Ops Bot команду. Попробуй позже.');
    }
  }

  private async replySafe(chatId: number, text: string): Promise<void> {
    try {
      await this.telegram.sendMessage(chatId, text);
    } catch (err) {
      this.logger.warn({ err: errMsg(err) }, 'ops reply failed');
    }
  }
}

function buildPayload(cmd: string, tail: string): Record<string, unknown> {
  if (cmd === 'echo-back' && tail) {
    return { token: tail };
  }
  return {};
}

function renderResult(cmd: string, result: OpsAgentResult): string {
  if (result.kind === 'command_ok') {
    const echo = (result.result?.echo as Record<string, unknown> | undefined)?.token;
    if (cmd === 'echo-back' && typeof echo === 'string') {
      return `✓ Ops Bot echo: «${echo}» (id ${result.command_id}).`;
    }
    return `✓ Команда «${cmd}» выполнена (id ${result.command_id}).`;
  }
  if (result.kind === 'command_failed') {
    const detail = result.detail ? ` — ${result.detail}` : '';
    return `⚠️ Команда «${cmd}» не выполнена (${result.reason})${detail}.`;
  }
  if (result.kind === 'unavailable') {
    return `⚠️ Ops Bot недоступен (${result.reason}).`;
  }
  return `⚠️ Неожиданный ответ Ops Bot.`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
