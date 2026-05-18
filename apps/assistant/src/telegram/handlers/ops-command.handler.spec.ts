import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { TelegramGateway } from '../../webhook/telegram.gateway.js';
import type { ApprovalService } from '../../approval/approval.service.js';
import type { OrchestratorService } from '../../orchestrator/orchestrator.service.js';
import type { OpsAgentResult } from '../../agents/ops-agent/ops-agent.service.js';

import { OpsCommandHandler } from './ops-command.handler.js';

function makeTelegram(): TelegramGateway {
  return {
    sendMessage: vi.fn(async () => undefined),
    sendMessageWithKeyboard: vi.fn(async () => undefined),
    getFileBuffer: vi.fn(async () => Buffer.alloc(0)),
    answerCallbackQuery: vi.fn(async () => undefined),
  };
}

function makeApproval(proposeImpl?: ApprovalService['propose']): {
  svc: ApprovalService;
  propose: ReturnType<typeof vi.fn>;
} {
  const propose = vi.fn(
    proposeImpl ??
      (async () => ({
        kind: 'approval_required',
        pendingId: '018f8e2a-1c2d-7000-9000-000000000001',
        approveCallback: 'approve:018f8e2a-1c2d-7000-9000-000000000001',
        rejectCallback: 'reject:018f8e2a-1c2d-7000-9000-000000000001',
        timeoutMs: 300_000,
        toolName: 'opsbot_command',
        payload: {},
      })),
  );
  return { svc: { propose } as unknown as ApprovalService, propose };
}

function makeOrchestrator(routeImpl?: OrchestratorService['route']): OrchestratorService {
  return {
    route: vi.fn(
      routeImpl ??
        (async () =>
          ({
            kind: 'command_ok',
            command_id: 'cmd-1',
            result: { echo: { token: 'ARCA-0009' } },
            executed_at: '2026-05-17T20:30:00.000Z',
          }) as OpsAgentResult),
    ),
    describeAgents: vi.fn(() => []),
  } as unknown as OrchestratorService;
}

describe('OpsCommandHandler.handle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses subcommand "echo-back ARCA-0009" and proposes approval', async () => {
    const telegram = makeTelegram();
    const { svc: approval, propose } = makeApproval();
    const orchestrator = makeOrchestrator();
    const handler = new OpsCommandHandler(telegram, approval, orchestrator);
    await handler.handle(42, 'echo-back ARCA-0009');
    expect(propose).toHaveBeenCalledTimes(1);
    const [tool, payload] = propose.mock.calls[0];
    expect(tool).toBe('opsbot_command');
    expect(payload).toMatchObject({
      cmd: 'echo-back',
      payload: { token: 'ARCA-0009' },
    });
    expect((payload as { idempotencyKey: string }).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(telegram.sendMessageWithKeyboard).toHaveBeenCalled();
  });

  it('parses bare command "health-probe" with empty payload', async () => {
    const telegram = makeTelegram();
    const { svc: approval, propose } = makeApproval();
    const orchestrator = makeOrchestrator();
    const handler = new OpsCommandHandler(telegram, approval, orchestrator);
    await handler.handle(42, 'health-probe');
    expect(propose).toHaveBeenCalledTimes(1);
    const [, payload] = propose.mock.calls[0];
    expect(payload).toMatchObject({ cmd: 'health-probe', payload: {} });
  });

  it('rejects unknown subcommand with hint and does NOT propose', async () => {
    const telegram = makeTelegram();
    const { svc: approval, propose } = makeApproval();
    const handler = new OpsCommandHandler(telegram, approval, makeOrchestrator());
    await handler.handle(42, 'delete-everything');
    expect(propose).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('echo-back'));
  });

  it('rejects empty command with usage hint', async () => {
    const telegram = makeTelegram();
    const { svc: approval, propose } = makeApproval();
    const handler = new OpsCommandHandler(telegram, approval, makeOrchestrator());
    await handler.handle(42, '');
    expect(propose).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('Использование'));
  });

  it('handles approval_not_required path by routing directly through orchestrator', async () => {
    const telegram = makeTelegram();
    const { svc: approval } = makeApproval(async () => ({
      kind: 'approval_not_required',
      toolName: 'opsbot_command',
    }));
    const orchestrator = makeOrchestrator();
    const handler = new OpsCommandHandler(telegram, approval, orchestrator);
    await handler.handle(42, 'echo-back ARCA-0009');
    expect(orchestrator.route).toHaveBeenCalledWith(
      '/opsbot_command',
      expect.objectContaining({ cmd: 'echo-back' }),
    );
    expect(telegram.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('echo'));
  });

  it('surfaces a friendly failure message on approval-service error', async () => {
    const telegram = makeTelegram();
    const { svc: approval } = makeApproval(async () => {
      throw new Error('redis down');
    });
    const handler = new OpsCommandHandler(telegram, approval, makeOrchestrator());
    await handler.handle(42, 'echo-back ARCA-0009');
    expect(telegram.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('⚠️'));
  });
});
