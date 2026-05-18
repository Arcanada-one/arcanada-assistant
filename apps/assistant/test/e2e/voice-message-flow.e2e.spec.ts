/**
 * ARCA-0009 M10 — E2E for V-AC-20 (voice-message → transcription).
 *
 * Drives the CommandRouter end-to-end with real handlers + orchestrator +
 * agent registry; only the outermost boundaries are mocked:
 *
 *   • TelegramGateway — captures replies, supplies audio bytes.
 *   • ITranscriberClient — canned STT response (msw not needed here; we mock
 *     the client interface directly because the real `TranscriberClient` is
 *     tested separately in transcriber.client.spec.ts).
 *
 * Plan §7 prescribed "driving fastify directly with mocked Telegram API". We
 * drive `CommandRouter.handle` instead — Fastify only adds Bearer-secret +
 * @Body parsing, both already covered by telegram.controller.spec.ts. This
 * shortcut is documented in datarim/tasks/ARCA-0009-task-description.md
 * § Implementation Notes (session 5 plan-deviation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AgentRegistry } from '../../src/orchestrator/agent.registry.js';
import { OrchestratorService } from '../../src/orchestrator/orchestrator.service.js';
import { CommandRouter } from '../../src/telegram/handlers/command-router.handler.js';
import { VoiceHandler } from '../../src/telegram/handlers/voice.handler.js';
import {
  TranscriberAgentService,
  type TranscribePayload,
} from '../../src/agents/transcriber/transcriber-agent.service.js';
import type { TranscribeResult } from '../../src/agents/transcriber/transcriber.schemas.js';
import type { ITranscriberClient } from '../../src/agents/transcriber/transcriber.client.js';
import type { TelegramGateway } from '../../src/webhook/telegram.gateway.js';

const SAMPLE_AUDIO = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // OggS magic
const SAMPLE_OK_RESULT: TranscribeResult = {
  kind: 'ok',
  transcription: 'Привет, это голосовое сообщение для ARCA-0009',
  provider: 'groq',
  model: 'whisper-large-v3',
  language: 'ru',
  latencyMs: 412,
  costUsd: 0.0008,
  audioDurationSeconds: 2.3,
  requestId: 'req-1',
  fallbackCount: 0,
};

interface Wiring {
  router: CommandRouter;
  telegram: TelegramGateway & {
    sendMessage: ReturnType<typeof vi.fn>;
    getFileBuffer: ReturnType<typeof vi.fn>;
  };
  client: ITranscriberClient & { transcribe: ReturnType<typeof vi.fn> };
}

function wire(transcribeImpl?: ITranscriberClient['transcribe']): Wiring {
  const telegram = {
    sendMessage: vi.fn(async () => undefined),
    sendMessageWithKeyboard: vi.fn(async () => undefined),
    getFileBuffer: vi.fn(async () => SAMPLE_AUDIO),
    answerCallbackQuery: vi.fn(async () => undefined),
  } satisfies TelegramGateway as TelegramGateway & {
    sendMessage: ReturnType<typeof vi.fn>;
    getFileBuffer: ReturnType<typeof vi.fn>;
  };
  const client = {
    transcribe: vi.fn(transcribeImpl ?? (async () => SAMPLE_OK_RESULT)),
    isCircuitOpen: vi.fn(() => false),
  } as unknown as ITranscriberClient & { transcribe: ReturnType<typeof vi.fn> };
  const agent = new TranscriberAgentService(client);
  const registry = new AgentRegistry();
  registry.register(agent);
  const orchestrator = new OrchestratorService(registry);
  const voice = new VoiceHandler(telegram, orchestrator);
  const noopHandler = { handle: vi.fn() } as unknown as never;
  const router = new CommandRouter(
    noopHandler,
    noopHandler,
    noopHandler,
    noopHandler,
    noopHandler,
    voice,
    noopHandler,
    noopHandler,
    noopHandler,
  );
  return { router, telegram, client };
}

describe('E2E V-AC-20 — voice-message-flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: Telegram voice update → TranscriberAgent → text reply', async () => {
    const { router, telegram, client } = wire();
    await router.handle({
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 42 },
        voice: { file_id: 'AwACAg-VOICE-1', mime_type: 'audio/ogg', duration: 2 },
      },
    });
    expect(telegram.getFileBuffer).toHaveBeenCalledWith('AwACAg-VOICE-1');
    expect(client.transcribe).toHaveBeenCalledTimes(1);
    const args = client.transcribe.mock.calls[0][0] as TranscribePayload;
    expect(args.mimeType).toBe('audio/ogg');
    expect(args.audio).toEqual(SAMPLE_AUDIO);
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      42,
      'Привет, это голосовое сообщение для ARCA-0009',
    );
  });

  it('rejects unsupported MIME without calling MC STT', async () => {
    const { router, telegram, client } = wire();
    await router.handle({
      update_id: 2,
      message: {
        message_id: 11,
        chat: { id: 42 },
        voice: { file_id: 'AwACAg-VOICE-2', mime_type: 'audio/garbage', duration: 1 },
      },
    });
    expect(client.transcribe).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringMatching(/Формат аудио .* не поддерживается/u),
    );
  });

  it('reports degraded result when MC STT returns unavailable', async () => {
    const { router, telegram } = wire(async () => ({
      kind: 'unavailable',
      reason: 'transcriber_circuit_open',
    }));
    await router.handle({
      update_id: 3,
      message: {
        message_id: 12,
        chat: { id: 42 },
        voice: { file_id: 'AwACAg-VOICE-3', mime_type: 'audio/ogg', duration: 2 },
      },
    });
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Транскрибатор недоступен'),
    );
  });

  it('handles download failure gracefully without throwing past router', async () => {
    const { router, telegram } = wire();
    (telegram.getFileBuffer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('telegram getFile 502'),
    );
    await router.handle({
      update_id: 4,
      message: {
        message_id: 13,
        chat: { id: 42 },
        voice: { file_id: 'AwACAg-VOICE-4', mime_type: 'audio/ogg', duration: 2 },
      },
    });
    expect(telegram.sendMessage).toHaveBeenCalledWith(
      42,
      '⚠️ Не удалось скачать голосовое сообщение.',
    );
  });

  it('measures end-to-end latency under 5s P95 (synthetic budget)', async () => {
    const { router } = wire();
    const start = performance.now();
    await router.handle({
      update_id: 5,
      message: {
        message_id: 14,
        chat: { id: 42 },
        voice: { file_id: 'AwACAg-VOICE-5', mime_type: 'audio/ogg', duration: 2 },
      },
    });
    const elapsed = performance.now() - start;
    // Plan V-AC-20 budget: voice → text < 5s P95. The mocked path elides STT
    // network cost — this assertion guards against unintentionally introducing
    // synchronous blocking work into the router/handler/agent path.
    expect(elapsed).toBeLessThan(5_000);
  });
});
