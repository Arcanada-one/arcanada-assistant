import { describe, expect, it, vi } from 'vitest';

import type { TelegramGateway } from '../../webhook/telegram.gateway.js';
import type { OrchestratorService } from '../../orchestrator/orchestrator.service.js';
import type { ApprovalClaimResult, ApprovalService } from '../../approval/approval.service.js';
import type { TaskResult } from '../../agents/munera/munera.schemas.js';

import {
  ApprovalCallbackHandler,
  type TelegramCallbackQuery,
} from './approval-callback.handler.js';

const PENDING_ID = '01941d7e-3b22-7c11-9f56-d4e3a8b9c012';
const CB_DATA_APPROVE = `apr:v1:a:${PENDING_ID}`;
const CB_DATA_REJECT = `apr:v1:r:${PENDING_ID}`;

const baseCallback = (data: string): TelegramCallbackQuery => ({
  id: 'cbq-1',
  from: { id: 4242, username: 'pavel' },
  data,
  message: { chat: { id: 99 }, message_id: 7 },
});

function makeGateway(overrides: Partial<TelegramGateway> = {}): TelegramGateway {
  return {
    sendMessage: vi.fn(async () => undefined),
    sendMessageWithKeyboard: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined),
    getFileBuffer: vi.fn(async () => Buffer.alloc(0)),
    ...overrides,
  };
}

function makeApproval(claim: ApprovalClaimResult): ApprovalService {
  return { claim: vi.fn(async () => claim) } as unknown as ApprovalService;
}

function makeOrchestrator(
  route: (intent: string, payload?: unknown) => Promise<unknown>,
): OrchestratorService {
  return { route: vi.fn(route) } as unknown as OrchestratorService;
}

describe('ApprovalCallbackHandler', () => {
  it('executes tool via orchestrator after approve and confirms to chat', async () => {
    const envelope = {
      tool_name: 'task_create',
      payload: { projectId: 'p', title: 'X' },
    };
    const approval = makeApproval({
      kind: 'approved',
      pendingId: PENDING_ID,
      decidedBy: '4242',
      envelope,
    });
    const okResult: TaskResult = {
      kind: 'ok',
      task: {
        id: '22222222-2222-7222-9222-222222222222',
        projectId: 'p',
        title: 'X',
        status: 'todo',
        createdAt: 't',
        updatedAt: 't',
      },
    };
    const orchestrator = makeOrchestrator(async () => okResult);
    const gateway = makeGateway();
    const handler = new ApprovalCallbackHandler(gateway, approval, orchestrator);

    await handler.handle(baseCallback(CB_DATA_APPROVE));

    expect(approval.claim).toHaveBeenCalledWith(PENDING_ID, 'approve', '4242');
    expect(orchestrator.route).toHaveBeenCalledWith('/task_create', envelope.payload);
    expect(gateway.answerCallbackQuery).toHaveBeenCalledWith('cbq-1', 'Принято');
    expect(gateway.sendMessage).toHaveBeenCalledTimes(1);
    expect((gateway.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toContain(
      'создана',
    );
  });

  it('does NOT execute orchestrator on reject and posts rejection note', async () => {
    const approval = makeApproval({
      kind: 'rejected',
      pendingId: PENDING_ID,
      decidedBy: '4242',
      envelope: { tool_name: 'task_create', payload: {} },
    });
    const orchestrator = makeOrchestrator(async () => {
      throw new Error('must not run on reject');
    });
    const gateway = makeGateway();
    const handler = new ApprovalCallbackHandler(gateway, approval, orchestrator);

    await handler.handle(baseCallback(CB_DATA_REJECT));

    expect(orchestrator.route).not.toHaveBeenCalled();
    expect(gateway.answerCallbackQuery).toHaveBeenCalledWith('cbq-1', 'Отклонено');
    const msg = (gateway.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toMatch(/отклонен/i);
  });

  it('handles already_decided as idempotent no-op with notice', async () => {
    const approval = makeApproval({ kind: 'already_decided', pendingId: PENDING_ID });
    const orchestrator = makeOrchestrator(async () => {
      throw new Error('must not run');
    });
    const gateway = makeGateway();
    const handler = new ApprovalCallbackHandler(gateway, approval, orchestrator);

    await handler.handle(baseCallback(CB_DATA_APPROVE));

    expect(orchestrator.route).not.toHaveBeenCalled();
    expect(gateway.answerCallbackQuery).toHaveBeenCalled();
    const msg = (gateway.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toMatch(/уже|expired|истек/i);
  });

  it('handles expired as no-op with expiry notice', async () => {
    const approval = makeApproval({ kind: 'expired', pendingId: PENDING_ID });
    const orchestrator = makeOrchestrator(async () => {
      throw new Error('must not run');
    });
    const gateway = makeGateway();
    const handler = new ApprovalCallbackHandler(gateway, approval, orchestrator);

    await handler.handle(baseCallback(CB_DATA_APPROVE));

    expect(orchestrator.route).not.toHaveBeenCalled();
    const msg = (gateway.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toMatch(/истек|expired/i);
  });

  it('rejects malformed callback_data without invoking approval', async () => {
    const approval = makeApproval({ kind: 'expired', pendingId: 'x' });
    const orchestrator = makeOrchestrator(async () => undefined);
    const gateway = makeGateway();
    const handler = new ApprovalCallbackHandler(gateway, approval, orchestrator);

    await handler.handle(baseCallback('garbage:not-a-callback'));

    expect(approval.claim).not.toHaveBeenCalled();
    expect(gateway.answerCallbackQuery).toHaveBeenCalled();
  });

  it('skips when callback_data is absent (Telegram protocol quirk)', async () => {
    const approval = makeApproval({ kind: 'expired', pendingId: 'x' });
    const orchestrator = makeOrchestrator(async () => undefined);
    const gateway = makeGateway();
    const handler = new ApprovalCallbackHandler(gateway, approval, orchestrator);

    await handler.handle({
      id: 'cbq-2',
      from: { id: 1 },
      message: { chat: { id: 1 }, message_id: 1 },
    });

    expect(approval.claim).not.toHaveBeenCalled();
  });
});
