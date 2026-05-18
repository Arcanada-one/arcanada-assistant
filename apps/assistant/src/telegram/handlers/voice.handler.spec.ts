import { describe, expect, it, vi } from 'vitest';

import type { TelegramGateway } from '../../webhook/telegram.gateway.js';
import type { OrchestratorService } from '../../orchestrator/orchestrator.service.js';
import type { TranscribeResult } from '../../agents/transcriber/transcriber.schemas.js';
import type { ClaudeService } from '../../chat/chat.service.js';

import { VoiceHandler, type TelegramVoice } from './voice.handler.js';

function makeGateway(overrides: Partial<TelegramGateway> = {}): TelegramGateway {
  return {
    sendMessage: vi.fn(async () => undefined),
    sendMessageWithKeyboard: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined),
    getFileBuffer: vi.fn(async () => Buffer.from('audio-bytes')),
    ...overrides,
  };
}

function makeOrchestrator(
  route: (intent: string, payload?: unknown) => Promise<unknown>,
): Pick<OrchestratorService, 'route'> {
  return { route: vi.fn(route) as OrchestratorService['route'] };
}

const VOICE: TelegramVoice = { file_id: 'AwACAg', mime_type: 'audio/ogg', duration: 3 };

describe('VoiceHandler', () => {
  it('routes voice through orchestrator and replies with transcription text', async () => {
    const okResult: TranscribeResult = {
      kind: 'ok',
      transcription: 'привет мир',
      provider: 'groq',
      model: 'whisper-large-v3',
      language: 'ru',
      latencyMs: 1200,
      costUsd: 0.001,
      audioDurationSeconds: 3,
      requestId: 'req-1',
      fallbackCount: 0,
    };
    const gateway = makeGateway();
    const orchestrator = makeOrchestrator(async () => okResult);
    const handler = new VoiceHandler(gateway, orchestrator as OrchestratorService);

    await handler.handle(42, VOICE);

    expect(gateway.getFileBuffer).toHaveBeenCalledWith('AwACAg');
    expect(orchestrator.route).toHaveBeenCalledWith('/transcribe', {
      audio: Buffer.from('audio-bytes'),
      mimeType: 'audio/ogg',
      filename: 'voice.ogg',
    });
    expect(gateway.sendMessage).toHaveBeenCalledWith(42, 'привет мир');
  });

  it('replies with user-friendly note when transcriber returns unavailable', async () => {
    const unavail: TranscribeResult = { kind: 'unavailable', reason: 'transcriber_circuit_open' };
    const gateway = makeGateway();
    const orchestrator = makeOrchestrator(async () => unavail);
    const handler = new VoiceHandler(gateway, orchestrator as OrchestratorService);

    await handler.handle(42, VOICE);

    expect(orchestrator.route).toHaveBeenCalledOnce();
    const msg = (gateway.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toMatch(/недоступ/i);
    expect(msg).toContain('transcriber_circuit_open');
  });

  it('handles unknown mime type gracefully without invoking orchestrator', async () => {
    const orchestrator = makeOrchestrator(async () => {
      throw new Error('should not be called');
    });
    const gateway = makeGateway();
    const handler = new VoiceHandler(gateway, orchestrator as OrchestratorService);

    await handler.handle(7, { file_id: 'x', mime_type: 'audio/exotic', duration: 1 });

    expect(orchestrator.route).not.toHaveBeenCalled();
    expect(gateway.sendMessage).toHaveBeenCalledTimes(1);
    const msg = (gateway.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(msg).toMatch(/не поддерживается|формат/i);
  });

  it('swallows orchestrator error and notifies user (fire-and-forget contract)', async () => {
    const gateway = makeGateway();
    const orchestrator = makeOrchestrator(async () => {
      throw new Error('boom');
    });
    const handler = new VoiceHandler(gateway, orchestrator as OrchestratorService);

    await expect(handler.handle(1, VOICE)).resolves.toBeUndefined();
    expect(gateway.sendMessage).toHaveBeenCalled();
  });

  // ARCA-0011 — voice handler routes successful STT through Claude when the
  // service is wired and userId is plumbed by the command-router.
  it('routes STT result through ClaudeService and replies with Claude answer', async () => {
    const okResult: TranscribeResult = {
      kind: 'ok',
      transcription: 'привет',
      provider: 'groq',
      model: 'whisper-large-v3',
      language: 'ru',
      latencyMs: 100,
      costUsd: 0.001,
      audioDurationSeconds: 1,
      requestId: 'req-1',
      fallbackCount: 0,
    };
    const gateway = makeGateway();
    const orchestrator = makeOrchestrator(async () => okResult);
    const chat: Pick<ClaudeService, 'handleTurn'> = {
      handleTurn: vi.fn().mockResolvedValue({
        systemPrompt: 'sp',
        userMessage: 'привет',
        reply: 'Здравствуй, чем могу помочь?',
        ragApplied: false,
        meta: { model: 'anthropic/claude-sonnet-4', costUsd: 0.0001, latencyMs: 200 },
      }),
    };
    const handler = new VoiceHandler(
      gateway,
      orchestrator as OrchestratorService,
      chat as ClaudeService,
    );

    await handler.handle(42, VOICE, 9001);

    expect(chat.handleTurn).toHaveBeenCalledWith(
      9001,
      'привет',
      expect.objectContaining({ modality: 'voice' }),
    );
    expect(gateway.sendMessage).toHaveBeenLastCalledWith(42, 'Здравствуй, чем могу помочь?');
  });

  it('falls back to transcription text if ChatService is not provided (DEV)', async () => {
    const okResult: TranscribeResult = {
      kind: 'ok',
      transcription: 'fallback text',
      provider: 'groq',
      model: 'm',
      language: 'ru',
      latencyMs: 1,
      costUsd: 0,
      audioDurationSeconds: 1,
      requestId: 'r',
      fallbackCount: 0,
    };
    const gateway = makeGateway();
    const orchestrator = makeOrchestrator(async () => okResult);
    const handler = new VoiceHandler(gateway, orchestrator as OrchestratorService);

    await handler.handle(42, VOICE, 9001);

    expect(gateway.sendMessage).toHaveBeenCalledWith(42, 'fallback text');
  });

  it('uses defaulted mime audio/ogg when Telegram update omits mime_type', async () => {
    const okResult: TranscribeResult = {
      kind: 'ok',
      transcription: 't',
      provider: 'p',
      model: 'm',
      language: 'ru',
      latencyMs: 1,
      costUsd: 0,
      audioDurationSeconds: 1,
      requestId: 'r',
      fallbackCount: 0,
    };
    const gateway = makeGateway();
    const orchestrator = makeOrchestrator(async () => okResult);
    const handler = new VoiceHandler(gateway, orchestrator as OrchestratorService);

    await handler.handle(1, { file_id: 'f', duration: 1 });

    expect(orchestrator.route).toHaveBeenCalledWith(
      '/transcribe',
      expect.objectContaining({ mimeType: 'audio/ogg' }),
    );
  });
});
