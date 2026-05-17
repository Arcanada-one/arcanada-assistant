/**
 * ARCA-0009 M10 — E2E for V-AC-3 (bidirectional Ops Bot command round-trip).
 *
 * Drives CommandRouter through the full /ops echo-back ARCA-0009 path:
 *
 *   1. Telegram message `/ops echo-back ARCA-0009` → OpsCommandHandler.
 *   2. OpsCommandHandler.propose → inline keyboard.
 *   3. callback_query «✓» → ApprovalCallbackHandler.claim → orchestrator.
 *   4. OrchestratorService.route('/opsbot_command', ...) → OpsAgentService.
 *   5. OpsAgentService → real OpsBotClient.executeCommand via msw-mocked
 *      Ops Bot HTTP server (POST /commands).
 *   6. Reply «✓ Ops Bot echo: …».
 *
 * Uses the real `OpsBotClient` (not a vi.fn stub) — exercises the audit
 * pre/post emit chain, Zod validation, and HTTP transport. The Ops Bot
 * receiving endpoint (cross-repo PR Arcanada-one/opsbot#6) is mocked here
 * via msw because the real service is not available in CI.
 *
 * See voice-message-flow.e2e.spec.ts header for the fastify-vs-router
 * deviation note.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { OpsBotClient, type ExecuteCommandResponse } from '@arcanada/core';

import { AgentRegistry } from '../../src/orchestrator/agent.registry.js';
import { OrchestratorService } from '../../src/orchestrator/orchestrator.service.js';
import { CommandRouter } from '../../src/telegram/handlers/command-router.handler.js';
import { OpsCommandHandler } from '../../src/telegram/handlers/ops-command.handler.js';
import { ApprovalCallbackHandler } from '../../src/telegram/handlers/approval-callback.handler.js';
import { ApprovalService } from '../../src/approval/approval.service.js';
import { parseApprovalPolicy } from '../../src/approval/approval-policy.loader.js';
import type {
  RedisIdempotencyService,
  ClaimOutcome,
} from '../../src/approval/redis-idempotency.service.js';
import { OpsAgentService } from '../../src/agents/ops-agent/ops-agent.service.js';
import type { TelegramGateway } from '../../src/webhook/telegram.gateway.js';

const BASE_URL = 'https://ops.test.local';
const API_KEY = 'arc_api_test_e2e';
const POLICY_YAML = `
version: 1
tools:
  - tool_name: opsbot_command
    requires_approval: true
    approval_timeout_ms: 60000
    idempotency_strategy: redis_nx
    approve_requires: []
`;

interface CapturedCommand {
  authorization: string | null;
  body: Record<string, unknown>;
}

interface CapturedAudit {
  message: unknown;
  context: unknown;
}

interface Wiring {
  router: CommandRouter;
  telegram: TelegramGateway & {
    sendMessage: ReturnType<typeof vi.fn>;
    sendMessageWithKeyboard: ReturnType<typeof vi.fn>;
  };
  commands: CapturedCommand[];
  audits: CapturedAudit[];
}

interface ClaimRecord {
  decision: 'approve' | 'reject';
  decided_by: string;
  decided_at: string;
  envelope: string;
}

function makeInMemoryIdempotency(): RedisIdempotencyService {
  const envelopes = new Map<string, { value: string; expiresAt: number }>();
  const claims = new Map<string, ClaimRecord>();
  return {
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
}

let mswServer: ReturnType<typeof setupServer> | null = null;

function startServer(): { commands: CapturedCommand[]; audits: CapturedAudit[] } {
  const commands: CapturedCommand[] = [];
  const audits: CapturedAudit[] = [];
  const handlers = [
    http.post(`${BASE_URL}/commands`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      commands.push({
        authorization: request.headers.get('authorization'),
        body,
      });
      const response: ExecuteCommandResponse = {
        ok: true,
        command_id: '01J3K9Q2V4ZAB6X8Y0R2M5N7P9',
        result: { echo: body.payload as Record<string, unknown> },
        executed_at: '2026-05-17T20:40:00.000Z',
      };
      return HttpResponse.json(response, { status: 200 });
    }),
    http.post(`${BASE_URL}/events`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      audits.push({ message: body.message, context: body.context });
      return HttpResponse.json(
        { event_id: '01J2H7K8FXYJ9P0Q3R5T6V8W0Z', status: 'accepted' },
        { status: 201 },
      );
    }),
  ];
  mswServer = setupServer(...handlers);
  mswServer.listen({ onUnhandledRequest: 'error' });
  return { commands, audits };
}

beforeAll(() => {
  // Server lifecycle managed per-test in wire() to allow handler override.
});
afterEach(() => {
  mswServer?.close();
  mswServer = null;
});
afterAll(() => {
  mswServer?.close();
});

function wire(): Wiring {
  const { commands, audits } = startServer();
  const telegram = {
    sendMessage: vi.fn(async () => undefined),
    sendMessageWithKeyboard: vi.fn(async () => undefined),
    getFileBuffer: vi.fn(async () => Buffer.alloc(0)),
    answerCallbackQuery: vi.fn(async () => undefined),
  } as TelegramGateway & {
    sendMessage: ReturnType<typeof vi.fn>;
    sendMessageWithKeyboard: ReturnType<typeof vi.fn>;
  };

  const opsBotClient = new OpsBotClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    timeoutMs: 1_000,
    retry: { maxAttempts: 0, baseDelayMs: 1 },
    circuit: {
      volumeThreshold: 100,
      errorThresholdPercentage: 99,
      rollingCountTimeout: 30_000,
      resetTimeout: 60_000,
    },
    emitSelfHealOnRecovery: false,
  });

  const registry = new AgentRegistry();
  registry.register(new OpsAgentService(opsBotClient));
  const orchestrator = new OrchestratorService(registry);

  const idempotency = makeInMemoryIdempotency();
  const policy = parseApprovalPolicy(POLICY_YAML);
  const approval = ApprovalService.withDeps(policy, idempotency);

  const ops = new OpsCommandHandler(telegram, approval, orchestrator);
  const callback = new ApprovalCallbackHandler(telegram, approval, orchestrator);
  const noop = { handle: vi.fn() } as unknown as never;
  const router = new CommandRouter(noop, noop, noop, noop, noop, noop, noop, ops, callback);
  return { router, telegram, commands, audits };
}

describe('E2E V-AC-3 — opsbot-bidirectional', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: /ops echo-back ARCA-0009 → approval → command round-trip + audit pair', async () => {
    const { router, telegram, commands, audits } = wire();
    await router.handle({
      update_id: 1,
      message: { message_id: 200, chat: { id: 42 }, text: '/ops echo-back ARCA-0009' },
    });
    expect(commands).toHaveLength(0);
    expect(telegram.sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
    const keyboard = telegram.sendMessageWithKeyboard.mock.calls[0][2];
    const approveBtn = keyboard[0][0] as { callbackData: string };

    await router.handle({
      update_id: 2,
      callback_query: {
        id: 'cbq-ops-1',
        from: { id: 14128108 },
        data: approveBtn.callbackData,
        message: { chat: { id: 42 }, message_id: 200 },
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0].authorization).toBe(`Bearer ${API_KEY}`);
    expect(commands[0].body).toMatchObject({
      cmd: 'echo-back',
      payload: { token: 'ARCA-0009' },
    });
    expect(commands[0].body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);

    // Audit envelopes: at least one pre-execute + one post-execute.
    const preExec = audits.filter((a) => a.message === 'opsbot-command-issued');
    const postExec = audits.filter((a) => a.message === 'opsbot-command-result');
    expect(preExec.length).toBeGreaterThanOrEqual(1);
    expect(postExec.length).toBeGreaterThanOrEqual(1);
    const postCtx = postExec[0].context as Record<string, unknown>;
    expect(postCtx.ok).toBe(true);
    expect(postCtx.command_id).toBe('01J3K9Q2V4ZAB6X8Y0R2M5N7P9');

    const replies = telegram.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(replies.some((r) => r.includes('Ops Bot echo: «ARCA-0009»'))).toBe(true);
  });

  it('rejects unknown subcommand at OpsCommandHandler without proposing approval', async () => {
    const { router, telegram, commands } = wire();
    await router.handle({
      update_id: 3,
      message: { message_id: 201, chat: { id: 42 }, text: '/ops delete-database' },
    });
    expect(telegram.sendMessageWithKeyboard).not.toHaveBeenCalled();
    expect(commands).toHaveLength(0);
    const replies = telegram.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(replies.some((r) => r.includes('Неизвестная команда'))).toBe(true);
  });

  it('bare /ops responds with usage hint and proposes nothing', async () => {
    const { router, telegram, commands } = wire();
    await router.handle({
      update_id: 4,
      message: { message_id: 202, chat: { id: 42 }, text: '/ops' },
    });
    expect(commands).toHaveLength(0);
    const replies = telegram.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(replies.some((r) => r.includes('Использование'))).toBe(true);
  });

  it('Ops Bot 503 → command_failed surfaced to user + error audit emitted', async () => {
    const { router, telegram, audits } = wire();
    mswServer!.use(
      http.post(`${BASE_URL}/commands`, () =>
        HttpResponse.json({ error: 'down' }, { status: 503 }),
      ),
    );
    await router.handle({
      update_id: 5,
      message: { message_id: 203, chat: { id: 42 }, text: '/ops echo-back ARCA-0009' },
    });
    const approveBtn = telegram.sendMessageWithKeyboard.mock.calls[0][2][0][0] as {
      callbackData: string;
    };
    await router.handle({
      update_id: 6,
      callback_query: {
        id: 'cbq-ops-err',
        from: { id: 1 },
        data: approveBtn.callbackData,
        message: { chat: { id: 42 }, message_id: 203 },
      },
    });
    const replies = telegram.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(
      replies.some((r) => r.includes('echo-back') && r.includes('не выполнена')),
    ).toBe(true);
    const errorAudits = audits.filter((a) => a.message === 'opsbot-command-error');
    expect(errorAudits.length).toBeGreaterThanOrEqual(1);
  });

  it('reject branch: tap «✗» → no HTTP call + rejection reply', async () => {
    const { router, telegram, commands } = wire();
    await router.handle({
      update_id: 7,
      message: { message_id: 204, chat: { id: 42 }, text: '/ops echo-back ARCA-0009' },
    });
    const rejectBtn = telegram.sendMessageWithKeyboard.mock.calls[0][2][0][1] as {
      callbackData: string;
    };
    await router.handle({
      update_id: 8,
      callback_query: {
        id: 'cbq-ops-rej',
        from: { id: 1 },
        data: rejectBtn.callbackData,
        message: { chat: { id: 42 }, message_id: 204 },
      },
    });
    expect(commands).toHaveLength(0);
    const replies = telegram.sendMessage.mock.calls.map((c) => c[1] as string);
    expect(replies.some((r) => r.includes('отклонено'))).toBe(true);
  });
});
