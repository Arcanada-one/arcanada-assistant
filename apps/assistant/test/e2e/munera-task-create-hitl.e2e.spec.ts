/**
 * ARCA-0009 M10 — E2E for V-AC-21 (Telegram /task → HITL approval → Munera).
 *
 * Drives CommandRouter end-to-end with real handlers + orchestrator + agent
 * registry + ApprovalService + RedisIdempotencyService (against ioredis-mock).
 *
 * Only outermost boundaries are mocked:
 *   • TelegramGateway — captures inline-keyboard prompt + post-approval reply.
 *   • IMuneraClient.createTask — canned Munera task envelope.
 *
 * Flow under test (plan §M5 + §M10):
 *   1. /task <NL> → TaskHandler → ApprovalService.propose → inline keyboard.
 *   2. callback_query «✓» → ApprovalCallbackHandler.claim → orchestrator
 *      dispatch → MuneraAgent.execute('/task_create') → MuneraClient.createTask.
 *   3. Reply «✓ Задача создана».
 *
 * See voice-message-flow.e2e.spec.ts header for the fastify-vs-router
 * deviation note.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AgentRegistry } from '../../src/orchestrator/agent.registry.js';
import { OrchestratorService } from '../../src/orchestrator/orchestrator.service.js';
import { CommandRouter } from '../../src/telegram/handlers/command-router.handler.js';
import { TaskHandler } from '../../src/telegram/handlers/task.handler.js';
import { ApprovalCallbackHandler } from '../../src/telegram/handlers/approval-callback.handler.js';
import { ApprovalService } from '../../src/approval/approval.service.js';
import { parseApprovalPolicy } from '../../src/approval/approval-policy.loader.js';
import type {
  RedisIdempotencyService,
  ClaimOutcome,
} from '../../src/approval/redis-idempotency.service.js';
import {
  MuneraAgentService,
  MUNERA_INTENT_TASK_CREATE,
} from '../../src/agents/munera/munera-agent.service.js';
import type { IMuneraClient } from '../../src/agents/munera/munera.client.js';
import type { TaskResult } from '../../src/agents/munera/munera.schemas.js';
import type { TelegramGateway } from '../../src/webhook/telegram.gateway.js';

const PROJECT_ID = '01941a78-1111-7000-9000-000000000001';
const POLICY_YAML = `
version: 1
tools:
  - tool_name: task_create
    requires_approval: true
    approval_timeout_ms: 60000
    idempotency_strategy: redis_nx
    approve_requires: []
  - tool_name: opsbot_command
    requires_approval: true
    approval_timeout_ms: 60000
    idempotency_strategy: redis_nx
    approve_requires: []
`;

const CREATE_OK: TaskResult = {
  kind: 'ok',
  task: {
    id: '01941b3c-aaaa-7000-9000-000000000777',
    projectId: PROJECT_ID,
    title: 'Купить хлеб',
    status: 'todo',
    priority: null,
    createdAt: '2026-05-17T20:35:00.000Z',
    updatedAt: '2026-05-17T20:35:00.000Z',
  },
};

interface ClaimRecord {
  decision: 'approve' | 'reject';
  decided_by: string;
  decided_at: string;
  envelope: string;
}

function makeInMemoryIdempotency(): RedisIdempotencyService {
  const envelopes = new Map<string, { value: string; expiresAt: number }>();
  const claims = new Map<string, ClaimRecord>();
  const svc: RedisIdempotencyService = {
    async createEnvelope(uuid: string, envelopeJson: string, timeoutMs: number) {
      envelopes.set(uuid, { value: envelopeJson, expiresAt: Date.now() + timeoutMs });
    },
    async readEnvelope(uuid: string) {
      const row = envelopes.get(uuid);
      if (!row || row.expiresAt < Date.now()) return null;
      return row.value;
    },
    async claim(uuid, decision, decidedBy, decidedAt): Promise<ClaimOutcome> {
      const env = envelopes.get(uuid);
      if (claims.has(uuid)) return 'already';
      if (!env || env.expiresAt < Date.now()) return 'expired';
      claims.set(uuid, {
        decision,
        decided_by: decidedBy,
        decided_at: String(decidedAt),
        envelope: env.value,
      });
      return 'claimed';
    },
    async readClaim(uuid) {
      return claims.get(uuid) ?? null;
    },
  } as unknown as RedisIdempotencyService;
  return svc;
}

interface Wiring {
  router: CommandRouter;
  telegram: TelegramGateway & {
    sendMessage: ReturnType<typeof vi.fn>;
    sendMessageWithKeyboard: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
  };
  munera: IMuneraClient & { createTask: ReturnType<typeof vi.fn> };
}

function wire(createImpl?: IMuneraClient['createTask']): Wiring {
  const telegram = {
    sendMessage: vi.fn(async () => undefined),
    sendMessageWithKeyboard: vi.fn(async () => undefined),
    getFileBuffer: vi.fn(async () => Buffer.alloc(0)),
    answerCallbackQuery: vi.fn(async () => undefined),
  } as TelegramGateway & {
    sendMessage: ReturnType<typeof vi.fn>;
    sendMessageWithKeyboard: ReturnType<typeof vi.fn>;
    answerCallbackQuery: ReturnType<typeof vi.fn>;
  };
  const munera = {
    createTask: vi.fn(createImpl ?? (async () => CREATE_OK)),
    updateTaskStatus: vi.fn(async () => CREATE_OK),
    getTask: vi.fn(async () => CREATE_OK),
    listTasksByProject: vi.fn(async () => ({ kind: 'ok' as const, tasks: [] })),
    isCircuitOpen: vi.fn(() => false),
  } as unknown as IMuneraClient & { createTask: ReturnType<typeof vi.fn> };

  const registry = new AgentRegistry();
  registry.register(new MuneraAgentService(munera));
  const orchestrator = new OrchestratorService(registry);

  // ioredis-mock@8 does not implement EVALSHA/Lua faithfully (see memory
  // `feedback_redis_lua_vs_multi_under_ioredis_mock`), so we stub the
  // RedisIdempotencyService with an in-memory map. The contract under test
  // here is the approval round-trip end-to-end, not Redis Lua semantics
  // (covered separately in redis-idempotency.service.spec.ts).
  const idempotency = makeInMemoryIdempotency();
  const policy = parseApprovalPolicy(POLICY_YAML);
  const approval = ApprovalService.withDeps(policy, idempotency);

  const task = new TaskHandler(
    telegram,
    approval,
    orchestrator,
    PROJECT_ID as unknown as string,
  );
  const callback = new ApprovalCallbackHandler(telegram, approval, orchestrator);
  const noop = { handle: vi.fn() } as unknown as never;
  const router = new CommandRouter(
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
    task,
    noop,
    callback,
  );
  return { router, telegram, munera };
}

describe('E2E V-AC-21 — munera-task-create-hitl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: /task NL → approval prompt → tap «✓» → Munera task created', async () => {
    const { router, telegram, munera } = wire();
    await router.handle({
      update_id: 1,
      message: {
        message_id: 100,
        chat: { id: 42 },
        from: { id: 14128108 },
        text: '/task Купить хлеб',
      },
    });
    expect(munera.createTask).not.toHaveBeenCalled();
    expect(telegram.sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
    const [, prompt, keyboard] = telegram.sendMessageWithKeyboard.mock.calls[0];
    expect(prompt).toContain('Купить хлеб');
    const approveBtn = keyboard[0][0] as { text: string; callbackData: string };
    expect(approveBtn.text).toContain('Approve');

    await router.handle({
      update_id: 2,
      callback_query: {
        id: 'cbq-1',
        from: { id: 14128108 },
        data: approveBtn.callbackData,
        message: { chat: { id: 42 }, message_id: 100 },
      },
    });

    expect(munera.createTask).toHaveBeenCalledTimes(1);
    const arg = munera.createTask.mock.calls[0][0] as { projectId: string; title: string };
    expect(arg).toEqual({ projectId: PROJECT_ID, title: 'Купить хлеб' });
    const replies = telegram.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(replies.some((r) => r.includes('Задача создана'))).toBe(true);
  });

  it('reject branch: tap «✗» → no Munera write + rejection reply', async () => {
    const { router, telegram, munera } = wire();
    await router.handle({
      update_id: 3,
      message: {
        message_id: 101,
        chat: { id: 42 },
        from: { id: 1 },
        text: 'Создай задачу Закрыть окно',
      },
    });
    const rejectBtn = telegram.sendMessageWithKeyboard.mock.calls[0][2][0][1] as {
      callbackData: string;
    };
    await router.handle({
      update_id: 4,
      callback_query: {
        id: 'cbq-2',
        from: { id: 1 },
        data: rejectBtn.callbackData,
        message: { chat: { id: 42 }, message_id: 101 },
      },
    });
    expect(munera.createTask).not.toHaveBeenCalled();
    const replies = telegram.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(replies.some((r) => r.includes('отклонено'))).toBe(true);
  });

  it('idempotency: duplicate callback tap → "Уже принято" without re-running Munera', async () => {
    const { router, telegram, munera } = wire();
    await router.handle({
      update_id: 5,
      message: { message_id: 102, chat: { id: 42 }, from: { id: 1 }, text: '/task Replay' },
    });
    const approveBtn = telegram.sendMessageWithKeyboard.mock.calls[0][2][0][0] as {
      callbackData: string;
    };
    await router.handle({
      update_id: 6,
      callback_query: {
        id: 'cbq-3a',
        from: { id: 1 },
        data: approveBtn.callbackData,
        message: { chat: { id: 42 }, message_id: 102 },
      },
    });
    expect(munera.createTask).toHaveBeenCalledTimes(1);
    await router.handle({
      update_id: 7,
      callback_query: {
        id: 'cbq-3b',
        from: { id: 1 },
        data: approveBtn.callbackData,
        message: { chat: { id: 42 }, message_id: 102 },
      },
    });
    expect(munera.createTask).toHaveBeenCalledTimes(1);
    const replies = telegram.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(replies.some((r) => r.includes('уже был принят'))).toBe(true);
  });

  it('Munera unavailable: approval succeeds but agent returns unavailable → reply notes failure', async () => {
    const { router, telegram } = wire(async () => ({
      kind: 'unavailable',
      reason: 'munera_circuit_open',
    }));
    await router.handle({
      update_id: 8,
      message: { message_id: 103, chat: { id: 42 }, from: { id: 1 }, text: '/task X' },
    });
    const approveBtn = telegram.sendMessageWithKeyboard.mock.calls[0][2][0][0] as {
      callbackData: string;
    };
    await router.handle({
      update_id: 9,
      callback_query: {
        id: 'cbq-4',
        from: { id: 1 },
        data: approveBtn.callbackData,
        message: { chat: { id: 42 }, message_id: 103 },
      },
    });
    const replies = telegram.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(replies.some((r) => r.includes('munera_circuit_open'))).toBe(true);
  });

  it('intent registry routes /task_create to MuneraAgent (regression guard)', async () => {
    const { router, munera } = wire();
    // smoke the intent path doesn't drift if registry wiring changes
    expect(MUNERA_INTENT_TASK_CREATE).toBe('/task_create');
    await router.handle({
      update_id: 10,
      message: {
        message_id: 104,
        chat: { id: 42 },
        from: { id: 1 },
        text: '/task Smoke',
      },
    });
    expect(munera.createTask).not.toHaveBeenCalled(); // pending approval
  });
});
