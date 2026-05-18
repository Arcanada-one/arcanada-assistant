import { describe, expect, it, vi } from 'vitest';

import type { TelegramGateway } from '../../webhook/telegram.gateway.js';
import type { OrchestratorService } from '../../orchestrator/orchestrator.service.js';
import type { ApprovalProposalOutcome, ApprovalService } from '../../approval/approval.service.js';
import type { TaskResult } from '../../agents/munera/munera.schemas.js';

import { TaskHandler } from './task.handler.js';

const PROJECT_ID = '11111111-1111-7111-9111-111111111111';
const PENDING_ID = '01941d7e-3b22-7c11-9f56-d4e3a8b9c012';

function makeGateway(overrides: Partial<TelegramGateway> = {}): TelegramGateway {
  return {
    sendMessage: vi.fn(async () => undefined),
    sendMessageWithKeyboard: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined),
    getFileBuffer: vi.fn(async () => Buffer.alloc(0)),
    ...overrides,
  };
}

function makeApproval(outcome: ApprovalProposalOutcome): ApprovalService {
  return {
    propose: vi.fn(async () => outcome),
  } as unknown as ApprovalService;
}

function makeOrchestrator(
  route: (intent: string, payload?: unknown) => Promise<unknown>,
): OrchestratorService {
  return { route: vi.fn(route) } as unknown as OrchestratorService;
}

describe('TaskHandler', () => {
  it('proposes approval and sends inline keyboard when approval required', async () => {
    const outcome: ApprovalProposalOutcome = {
      kind: 'approval_required',
      pendingId: PENDING_ID,
      approveCallback: `apr:v1:a:${PENDING_ID}`,
      rejectCallback: `apr:v1:r:${PENDING_ID}`,
      timeoutMs: 300_000,
      toolName: 'task_create',
      payload: { projectId: PROJECT_ID, title: 'Купить хлеб' },
    };
    const gateway = makeGateway();
    const approval = makeApproval(outcome);
    const orchestrator = makeOrchestrator(async () => {
      throw new Error('orchestrator must not run on proposal');
    });
    const handler = new TaskHandler(gateway, approval, orchestrator, PROJECT_ID);

    await handler.handle(99, 'Купить хлеб');

    expect(approval.propose).toHaveBeenCalledWith('task_create', {
      projectId: PROJECT_ID,
      title: 'Купить хлеб',
    });
    expect(gateway.sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
    const [chat, text, rows] = (gateway.sendMessageWithKeyboard as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(chat).toBe(99);
    expect(text).toContain('Купить хлеб');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(2);
    expect(rows[0]?.[0]?.callbackData).toBe(outcome.approveCallback);
    expect(rows[0]?.[1]?.callbackData).toBe(outcome.rejectCallback);
    expect(orchestrator.route).not.toHaveBeenCalled();
  });

  it('executes task directly when approval not required', async () => {
    const okResult: TaskResult = {
      kind: 'ok',
      task: {
        id: '22222222-2222-7222-9222-222222222222',
        projectId: PROJECT_ID,
        title: 'Купить хлеб',
        status: 'todo',
        createdAt: '2026-05-17T00:00:00Z',
        updatedAt: '2026-05-17T00:00:00Z',
      },
    };
    const gateway = makeGateway();
    const approval = makeApproval({
      kind: 'approval_not_required',
      toolName: 'task_create',
    });
    const orchestrator = makeOrchestrator(async () => okResult);
    const handler = new TaskHandler(gateway, approval, orchestrator, PROJECT_ID);

    await handler.handle(99, 'Купить хлеб');

    expect(orchestrator.route).toHaveBeenCalledWith('/task_create', {
      projectId: PROJECT_ID,
      title: 'Купить хлеб',
    });
    expect(gateway.sendMessage).toHaveBeenCalledTimes(1);
    expect(gateway.sendMessageWithKeyboard).not.toHaveBeenCalled();
  });

  it('rejects empty title with friendly message and no orchestrator/approval calls', async () => {
    const gateway = makeGateway();
    const approval = makeApproval({
      kind: 'approval_not_required',
      toolName: 'task_create',
    });
    const orchestrator = makeOrchestrator(async () => {
      throw new Error('must not run');
    });
    const handler = new TaskHandler(gateway, approval, orchestrator, PROJECT_ID);

    await handler.handle(99, '   ');

    expect(approval.propose).not.toHaveBeenCalled();
    expect(orchestrator.route).not.toHaveBeenCalled();
    const msg = (gateway.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toMatch(/название|title/i);
  });

  it('reports configuration error when default projectId is unset', async () => {
    const gateway = makeGateway();
    const approval = makeApproval({
      kind: 'approval_not_required',
      toolName: 'task_create',
    });
    const orchestrator = makeOrchestrator(async () => {
      throw new Error('must not run');
    });
    const handler = new TaskHandler(gateway, approval, orchestrator, undefined);

    await handler.handle(99, 'Hello');

    expect(approval.propose).not.toHaveBeenCalled();
    expect(orchestrator.route).not.toHaveBeenCalled();
    const msg = (gateway.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toMatch(/проект|MUNERA_DEFAULT_PROJECT_ID/);
  });

  it('swallows approval errors and notifies user', async () => {
    const gateway = makeGateway();
    const approval = {
      propose: vi.fn(async () => {
        throw new Error('redis-down');
      }),
    } as unknown as ApprovalService;
    const orchestrator = makeOrchestrator(async () => undefined);
    const handler = new TaskHandler(gateway, approval, orchestrator, PROJECT_ID);

    await expect(handler.handle(1, 'X')).resolves.toBeUndefined();
    expect(gateway.sendMessage).toHaveBeenCalled();
  });

  it('parses NL prefix "создай задачу" via the static helper', () => {
    expect(TaskHandler.parseNL('создай задачу Купить хлеб')).toBe('Купить хлеб');
    expect(TaskHandler.parseNL('Создайте задачу: позвонить врачу')).toBe('позвонить врачу');
    expect(TaskHandler.parseNL('запомни что я молодец')).toBeNull();
    expect(TaskHandler.parseNL('/wiki создай задачу')).toBeNull();
  });
});
