import { describe, expect, it, vi } from 'vitest';

import { ClaudeClient } from './claude.client.js';
import type { ClaudeCompletionRequest } from './claude.schemas.js';

function makeReq(
  overrides: Partial<ClaudeCompletionRequest> = {},
): ClaudeCompletionRequest {
  return {
    systemPrompt: 'Ты — Arcanada Assistant.',
    content: 'Привет',
    ...overrides,
  } as ClaudeCompletionRequest;
}

function mcResponse(
  status: number,
  body: unknown,
  contentType = 'application/json',
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });
}

const successBody = {
  id: 'gen-test-1',
  connector: 'openrouter',
  model: 'anthropic/claude-sonnet-4',
  result: 'Привет! Чем могу помочь?',
  usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18, costUsd: 0.0003 },
  latencyMs: 312,
  status: 'success',
};

describe('ClaudeClient', () => {
  const baseUrl = 'http://localhost:3900';
  const apiKey = 'mc-test-key';

  it('returns ok result on MC 201 success', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(mcResponse(201, successBody));
    const client = new ClaudeClient({ baseUrl, apiKey, fetchImpl });

    const result = await client.complete(makeReq());

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.reply).toBe('Привет! Чем могу помочь?');
      expect(result.inputTokens).toBe(10);
      expect(result.costUsd).toBeCloseTo(0.0003, 6);
      expect(result.model).toBe('anthropic/claude-sonnet-4');
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0];
    const initBody = JSON.parse((init as { body: string }).body) as Record<string, unknown>;
    expect(initBody.connector).toBe('openrouter');
    expect(initBody.prompt).toBe('Привет');
    expect(initBody.systemPrompt).toBe('Ты — Arcanada Assistant.');
  });

  it('forwards ContentBlock[] prompts verbatim to MC', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(mcResponse(201, successBody));
    const client = new ClaudeClient({ baseUrl, apiKey, fetchImpl });
    await client.complete(
      makeReq({
        content: [
          { type: 'text', text: 'Опиши' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
          },
        ],
      }),
    );
    const [, init] = fetchImpl.mock.calls[0];
    const initBody = JSON.parse((init as { body: string }).body) as { prompt: unknown };
    expect(Array.isArray(initBody.prompt)).toBe(true);
    const blocks = initBody.prompt as Array<{ type: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1].type).toBe('image_url');
  });

  it('retries once on transient 503 then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mcResponse(503, { statusCode: 503, message: 'temporary' }))
      .mockResolvedValueOnce(mcResponse(201, successBody));
    const client = new ClaudeClient({
      baseUrl,
      apiKey,
      fetchImpl,
      retry: { maxAttempts: 1, baseDelayMs: 1 },
    });
    const result = await client.complete(makeReq());
    expect(result.kind).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns unavailable for 401 unauthorized (client fault, not retryable)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mcResponse(401, { statusCode: 401, message: 'bad key' }));
    const client = new ClaudeClient({ baseUrl, apiKey, fetchImpl });
    const result = await client.complete(makeReq());
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.statusCode).toBe(401);
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns unavailable when MC reports unsupported_modality in success envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      mcResponse(400, {
        ...successBody,
        status: 'error',
        error: {
          type: 'unsupported_modality',
          message: 'Connector openrouter does not support arrays',
          retryable: false,
          recommendation: 'abort',
        },
      }),
    );
    const client = new ClaudeClient({ baseUrl, apiKey, fetchImpl });
    const result = await client.complete(
      makeReq({ content: [{ type: 'text', text: 'hi' }] }),
    );
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('claude_unsupported_modality');
    }
  });

  it('rejects malformed requests synchronously', async () => {
    const fetchImpl = vi.fn();
    const client = new ClaudeClient({ baseUrl, apiKey, fetchImpl });
    await expect(
      client.complete({
        systemPrompt: '',
        content: 'hi',
      } as unknown as ClaudeCompletionRequest),
    ).rejects.toThrow(/Invalid claude completion request/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('opens circuit after sustained 500s', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mcResponse(500, { statusCode: 500, message: 'boom' }));
    const client = new ClaudeClient({
      baseUrl,
      apiKey,
      fetchImpl,
      retry: { maxAttempts: 0, baseDelayMs: 1 },
      circuit: {
        volumeThreshold: 1,
        errorThresholdPercentage: 1,
        rollingCountTimeout: 1000,
        resetTimeout: 60_000,
      },
    });
    for (let i = 0; i < 4; i += 1) {
      const r = await client.complete(makeReq());
      expect(r.kind).toBe('unavailable');
    }
    expect(client.isCircuitOpen()).toBe(true);
  });
});
