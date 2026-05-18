import { describe, expect, it, vi } from 'vitest';

import { TranscriberClient, TranscriberClientError } from './transcriber.client.js';
import type { TranscribeRequest } from './transcriber.schemas.js';

function makeReq(overrides: Partial<TranscribeRequest> = {}): TranscribeRequest {
  return {
    audio: Buffer.from('fake-audio-bytes'),
    filename: 'voice.mp3',
    mimeType: 'audio/mp3',
    language: 'ru',
    ...overrides,
  } as TranscribeRequest;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TranscriberClient', () => {
  const baseUrl = 'http://localhost:3900';
  const apiKey = 'mc-test-key';

  it('returns ok result on 200 with valid envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        transcription: 'Привет мир',
        model: 'whisper-large-v3',
        provider: 'groq',
        language: 'ru',
        latency_ms: 283,
        cost_usd: 0.000031,
        audio_duration_seconds: 1,
        fallback_count: 0,
        request_id: '11111111-1111-4111-8111-111111111111',
      }),
    );
    const client = new TranscriberClient({ baseUrl, apiKey, fetchImpl: fetchImpl as never });
    const result = await client.transcribe(makeReq());
    expect(result).toEqual({
      kind: 'ok',
      transcription: 'Привет мир',
      provider: 'groq',
      model: 'whisper-large-v3',
      language: 'ru',
      latencyMs: 283,
      costUsd: 0.000031,
      audioDurationSeconds: 1,
      requestId: '11111111-1111-4111-8111-111111111111',
      fallbackCount: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${baseUrl}/v1/speech/stt`);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('maps 401 unauthorized envelope to unavailable result', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(401, {
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Missing Bearer token',
      }),
    );
    const client = new TranscriberClient({ baseUrl, apiKey, fetchImpl: fetchImpl as never });
    const result = await client.transcribe(makeReq());
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('transcriber_unauthorized');
      expect(result.statusCode).toBe(401);
    }
  });

  it('maps 400 stt_validation_error envelope to unavailable result', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        statusCode: 400,
        error_code: 'stt_validation_error',
        message: 'mimeType: mimeType must be one of: ...',
      }),
    );
    const client = new TranscriberClient({ baseUrl, apiKey, fetchImpl: fetchImpl as never });
    const result = await client.transcribe(makeReq());
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('transcriber_validation_error');
      expect(result.errorCode).toBe('stt_validation_error');
      expect(result.statusCode).toBe(400);
    }
  });

  it('retries on 500, succeeds on second attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(500, {
          statusCode: 500,
          error_code: 'stt_provider_failed',
          message: 'transient',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          transcription: 'retry-success',
          model: 'whisper-large-v3',
          provider: 'groq',
          language: 'ru',
          latency_ms: 10,
          cost_usd: 0,
          audio_duration_seconds: 1,
          fallback_count: 0,
          request_id: 'r-2',
        }),
      );
    const client = new TranscriberClient({
      baseUrl,
      apiKey,
      fetchImpl: fetchImpl as never,
      retry: { maxAttempts: 2, baseDelayMs: 1 },
    });
    const result = await client.transcribe(makeReq());
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.transcription).toBe('retry-success');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('opens circuit after volumeThreshold consecutive 500s and returns circuit_open', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(500, {
        statusCode: 500,
        error_code: 'stt_provider_failed',
        message: 'down',
      }),
    );
    const client = new TranscriberClient({
      baseUrl,
      apiKey,
      fetchImpl: fetchImpl as never,
      retry: { maxAttempts: 0, baseDelayMs: 1 },
      circuit: {
        volumeThreshold: 3,
        errorThresholdPercentage: 99,
        rollingCountTimeout: 30_000,
        resetTimeout: 60_000,
      },
    });
    for (let i = 0; i < 5; i += 1) {
      await client.transcribe(makeReq()).catch(() => undefined);
    }
    expect(client.isCircuitOpen()).toBe(true);
    const result = await client.transcribe(makeReq());
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('transcriber_circuit_open');
  });

  it('rejects payload with disallowed mime via Zod', async () => {
    const client = new TranscriberClient({ baseUrl, apiKey });
    await expect(
      client.transcribe(makeReq({ mimeType: 'audio/foo' as never })),
    ).rejects.toBeInstanceOf(TranscriberClientError);
  });

  it('rejects payload with non-Buffer audio', async () => {
    const client = new TranscriberClient({ baseUrl, apiKey });
    await expect(
      client.transcribe(makeReq({ audio: 'not-a-buffer' as never })),
    ).rejects.toBeInstanceOf(TranscriberClientError);
  });
});
