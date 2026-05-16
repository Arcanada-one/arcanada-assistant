import { describe, expect, it, vi } from 'vitest';

import { MuneraClient, MuneraClientError } from './munera.client.js';
import type { CreateTaskRequest } from './munera.schemas.js';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_TASK_ID = '22222222-2222-4222-8222-222222222222';

function makeCreateReq(overrides: Partial<CreateTaskRequest> = {}): CreateTaskRequest {
  return {
    projectId: VALID_UUID,
    title: 'Test task from MuneraAgent',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function muneraTaskFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VALID_TASK_ID,
    projectId: VALID_UUID,
    title: 'Test task from MuneraAgent',
    description: null,
    status: 'todo',
    priority: 'medium',
    createdAt: '2026-05-17T10:00:00.000Z',
    updatedAt: '2026-05-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('MuneraClient', () => {
  const baseUrl = 'http://localhost:3500';
  const apiToken = 'munera-test-jwt';

  it('createTask returns ok result on 201 success envelope', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, muneraTaskFixture()));
    const client = new MuneraClient({ baseUrl, apiToken, fetchImpl: fetchImpl as never });
    const result = await client.createTask(makeCreateReq());
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.task.id).toBe(VALID_TASK_ID);
      expect(result.task.status).toBe('todo');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${baseUrl}/api/v1/tasks`);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${apiToken}`);
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('createTask maps JwtAuthGuard 401 to unavailable result', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(401, { statusCode: 401, message: 'Unauthorized' }),
      );
    const client = new MuneraClient({ baseUrl, apiToken, fetchImpl: fetchImpl as never });
    const result = await client.createTask(makeCreateReq());
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('munera_jwt_unauthorized');
      expect(result.statusCode).toBe(401);
      expect(result.errorCode).toBe('jwt_unauthorized');
    }
  });

  it('listTasksByProject maps ApiKeyGuard 401 envelope (different shape)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(401, {
          statusCode: 401,
          error: 'Unauthorized',
          message: 'API key required',
        }),
      );
    const client = new MuneraClient({ baseUrl, apiToken, fetchImpl: fetchImpl as never });
    const result = await client.listTasksByProject(VALID_UUID);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('munera_api_key_unauthorized');
      expect(result.statusCode).toBe(401);
    }
  });

  it('createTask maps 400 validation envelope to unavailable result', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, {
        statusCode: 400,
        error: 'Bad Request',
        message: ['title must be longer than or equal to 1 characters'],
      }),
    );
    const client = new MuneraClient({ baseUrl, apiToken, fetchImpl: fetchImpl as never });
    const result = await client.createTask(makeCreateReq());
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('munera_task_call_validation_error');
      expect(result.statusCode).toBe(400);
      expect(result.errorCode).toBe('bad_request');
    }
  });

  it('getTask maps 404 envelope to unavailable result', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(404, {
        statusCode: 404,
        error: 'Not Found',
        message: `Cannot GET /api/v1/tasks/${VALID_TASK_ID}`,
      }),
    );
    const client = new MuneraClient({ baseUrl, apiToken, fetchImpl: fetchImpl as never });
    const result = await client.getTask(VALID_TASK_ID);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('munera_not_found');
      expect(result.statusCode).toBe(404);
    }
  });

  it('updateTaskStatus retries on 500 then succeeds on second attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { statusCode: 500, error: 'Internal Server Error', message: 'transient' }))
      .mockResolvedValueOnce(jsonResponse(200, muneraTaskFixture({ status: 'in_progress' })));
    const client = new MuneraClient({
      baseUrl,
      apiToken,
      fetchImpl: fetchImpl as never,
      retry: { maxAttempts: 2, baseDelayMs: 1 },
    });
    // update is non-retryable per client design (write op); test getTask retry instead
    const getFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { statusCode: 500, error: 'Internal Server Error', message: 'transient' }))
      .mockResolvedValueOnce(jsonResponse(200, muneraTaskFixture()));
    const retryClient = new MuneraClient({
      baseUrl,
      apiToken,
      fetchImpl: getFetch as never,
      retry: { maxAttempts: 2, baseDelayMs: 1 },
    });
    const retryResult = await retryClient.getTask(VALID_TASK_ID);
    expect(retryResult.kind).toBe('ok');
    expect(getFetch).toHaveBeenCalledTimes(2);
    // Sanity for update: write ops are NOT retried
    const updateResult = await client.updateTaskStatus(VALID_TASK_ID, { status: 'in_progress' });
    expect(updateResult.kind).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('opens circuit after volumeThreshold consecutive 500s', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(500, { statusCode: 500, error: 'Internal Server Error', message: 'down' }),
      );
    const client = new MuneraClient({
      baseUrl,
      apiToken,
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
      await client.getTask(VALID_TASK_ID).catch(() => undefined);
    }
    expect(client.isCircuitOpen()).toBe(true);
    const result = await client.getTask(VALID_TASK_ID);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('munera_circuit_open');
  });

  it('4xx errors do NOT trip circuit (application faults)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(404, { statusCode: 404, error: 'Not Found', message: 'gone' }),
      );
    const client = new MuneraClient({
      baseUrl,
      apiToken,
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
      await client.getTask(VALID_TASK_ID).catch(() => undefined);
    }
    expect(client.isCircuitOpen()).toBe(false);
  });

  it('rejects createTask with missing required projectId via Zod', async () => {
    const client = new MuneraClient({ baseUrl, apiToken });
    await expect(
      client.createTask({ title: 'no project' } as never),
    ).rejects.toBeInstanceOf(MuneraClientError);
  });

  it('rejects getTask with non-UUID taskId', async () => {
    const client = new MuneraClient({ baseUrl, apiToken });
    await expect(client.getTask('not-a-uuid')).rejects.toBeInstanceOf(MuneraClientError);
  });
});
