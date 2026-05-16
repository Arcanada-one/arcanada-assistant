import { describe, expect, it, vi } from 'vitest';

import { TranscriberAgentService } from './transcriber-agent.service.js';
import type { ITranscriberClient } from './transcriber.client.js';
import type { TranscribeResult } from './transcriber.schemas.js';

function makeClient(overrides: Partial<ITranscriberClient> = {}): ITranscriberClient {
  return {
    transcribe: vi.fn(),
    isCircuitOpen: vi.fn().mockReturnValue(false),
    ...overrides,
  } as ITranscriberClient;
}

const okResult: TranscribeResult = {
  kind: 'ok',
  transcription: 'hello',
  provider: 'groq',
  model: 'whisper-large-v3',
  language: 'ru',
  latencyMs: 100,
  costUsd: 0.00001,
  audioDurationSeconds: 1,
  requestId: 'r-1',
  fallbackCount: 0,
};

describe('TranscriberAgentService', () => {
  it('claims only the /transcribe intent', () => {
    const svc = new TranscriberAgentService(makeClient());
    expect(svc.name).toBe('transcriber');
    expect(svc.intents).toEqual(['/transcribe']);
  });

  it('returns unavailable when circuit is open', async () => {
    const client = makeClient({ isCircuitOpen: vi.fn().mockReturnValue(true) });
    const svc = new TranscriberAgentService(client);
    const result = await svc.execute('/transcribe', {
      audio: Buffer.from('x'),
      mimeType: 'audio/mp3',
    });
    expect(result).toEqual({ kind: 'unavailable', reason: 'transcriber_circuit_open' });
    expect(client.transcribe).not.toHaveBeenCalled();
  });

  it('returns unavailable on empty/missing audio', async () => {
    const svc = new TranscriberAgentService(makeClient());
    expect(await svc.execute('/transcribe', undefined)).toEqual({
      kind: 'unavailable',
      reason: 'transcriber_empty_audio',
    });
    expect(
      await svc.execute('/transcribe', { audio: Buffer.alloc(0), mimeType: 'audio/mp3' }),
    ).toEqual({ kind: 'unavailable', reason: 'transcriber_empty_audio' });
  });

  it('rejects unsupported MIME without hitting the client', async () => {
    const client = makeClient();
    const svc = new TranscriberAgentService(client);
    const result = await svc.execute('/transcribe', {
      audio: Buffer.from('x'),
      mimeType: 'audio/foo',
    });
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('transcriber_unsupported_mime');
    expect(client.transcribe).not.toHaveBeenCalled();
  });

  it('delegates to client on happy path', async () => {
    const transcribe = vi.fn().mockResolvedValueOnce(okResult);
    const client = makeClient({ transcribe });
    const svc = new TranscriberAgentService(client);
    const result = await svc.execute('/transcribe', {
      audio: Buffer.from('x'),
      mimeType: 'audio/mp3',
      language: 'ru',
    });
    expect(result).toEqual(okResult);
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'audio/mp3',
        language: 'ru',
        filename: 'voice.mp3',
      }),
    );
  });

  it('throws on unknown intent', async () => {
    const svc = new TranscriberAgentService(makeClient());
    await expect(svc.execute('/wat', {})).rejects.toThrow(/does not handle intent/);
  });

  it('maps thrown client errors into unavailable result', async () => {
    const transcribe = vi.fn().mockRejectedValueOnce(new Error('network reset'));
    const client = makeClient({ transcribe });
    const svc = new TranscriberAgentService(client);
    const result = await svc.execute('/transcribe', {
      audio: Buffer.from('x'),
      mimeType: 'audio/mp3',
    });
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('transcriber_error');
      expect(result.detail).toBe('network reset');
    }
  });
});
