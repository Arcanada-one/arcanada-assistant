import { describe, expect, it, vi } from 'vitest';

import type { IMuneraClient } from './munera.client.js';
import {
  MuneraAgentService,
  MUNERA_INTENT_TASK_CREATE,
  MUNERA_INTENT_TASK_GET,
  MUNERA_INTENT_TASK_LIST,
  MUNERA_INTENT_TASK_UPDATE,
} from './munera-agent.service.js';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';

function makeClientStub(overrides: Partial<IMuneraClient> = {}): IMuneraClient {
  return {
    createTask: vi.fn(),
    updateTaskStatus: vi.fn(),
    getTask: vi.fn(),
    listTasksByProject: vi.fn(),
    isCircuitOpen: vi.fn().mockReturnValue(false),
    ...overrides,
  } as IMuneraClient;
}

describe('MuneraAgentService', () => {
  it('claims task_create / task_update / task_get / task_list intents', () => {
    const agent = new MuneraAgentService(makeClientStub());
    expect(agent.name).toBe('munera');
    expect(agent.intents).toEqual([
      MUNERA_INTENT_TASK_CREATE,
      MUNERA_INTENT_TASK_UPDATE,
      MUNERA_INTENT_TASK_GET,
      MUNERA_INTENT_TASK_LIST,
    ]);
  });

  it('returns unavailable when circuit is open', async () => {
    const client = makeClientStub({
      isCircuitOpen: vi.fn().mockReturnValue(true),
    });
    const agent = new MuneraAgentService(client);
    const result = await agent.execute(MUNERA_INTENT_TASK_CREATE, {
      projectId: VALID_UUID,
      title: 'x',
    });
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toBe('munera_circuit_open');
  });

  it('dispatches /task_create to client.createTask', async () => {
    const createTask = vi.fn().mockResolvedValue({
      kind: 'ok',
      task: {
        id: TASK_ID,
        projectId: VALID_UUID,
        title: 't',
        status: 'todo',
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
      },
    });
    const client = makeClientStub({ createTask });
    const agent = new MuneraAgentService(client);
    await agent.execute(MUNERA_INTENT_TASK_CREATE, {
      projectId: VALID_UUID,
      title: 't',
    });
    expect(createTask).toHaveBeenCalledWith({
      projectId: VALID_UUID,
      title: 't',
    });
  });

  it('rejects /task_create payload that is not an object', async () => {
    const agent = new MuneraAgentService(makeClientStub());
    const result = await agent.execute(MUNERA_INTENT_TASK_CREATE, null);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('munera_invalid_create_payload');
    }
  });

  it('dispatches /task_update to client.updateTaskStatus with split taskId', async () => {
    const updateTaskStatus = vi.fn().mockResolvedValue({
      kind: 'ok',
      task: {
        id: TASK_ID,
        projectId: VALID_UUID,
        title: 't',
        status: 'in_progress',
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
      },
    });
    const client = makeClientStub({ updateTaskStatus });
    const agent = new MuneraAgentService(client);
    await agent.execute(MUNERA_INTENT_TASK_UPDATE, {
      taskId: TASK_ID,
      status: 'in_progress',
    });
    expect(updateTaskStatus).toHaveBeenCalledWith(TASK_ID, { status: 'in_progress' });
  });

  it('rejects /task_update without taskId', async () => {
    const agent = new MuneraAgentService(makeClientStub());
    const result = await agent.execute(MUNERA_INTENT_TASK_UPDATE, { status: 'todo' });
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('munera_invalid_update_payload');
    }
  });

  it('dispatches /task_get to client.getTask', async () => {
    const getTask = vi.fn().mockResolvedValue({
      kind: 'ok',
      task: {
        id: TASK_ID,
        projectId: VALID_UUID,
        title: 't',
        status: 'todo',
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
      },
    });
    const client = makeClientStub({ getTask });
    const agent = new MuneraAgentService(client);
    await agent.execute(MUNERA_INTENT_TASK_GET, { taskId: TASK_ID });
    expect(getTask).toHaveBeenCalledWith(TASK_ID);
  });

  it('dispatches /task_list to client.listTasksByProject', async () => {
    const listTasksByProject = vi.fn().mockResolvedValue({ kind: 'ok', tasks: [] });
    const client = makeClientStub({ listTasksByProject });
    const agent = new MuneraAgentService(client);
    await agent.execute(MUNERA_INTENT_TASK_LIST, { projectId: VALID_UUID });
    expect(listTasksByProject).toHaveBeenCalledWith(VALID_UUID);
  });

  it('throws on unknown intent', async () => {
    const agent = new MuneraAgentService(makeClientStub());
    await expect(agent.execute('/unknown', {})).rejects.toThrow(/does not handle/);
  });

  it('catches client throw and maps to unavailable', async () => {
    const createTask = vi.fn().mockRejectedValue(new Error('boom'));
    const client = makeClientStub({ createTask });
    const agent = new MuneraAgentService(client);
    const result = await agent.execute(MUNERA_INTENT_TASK_CREATE, {
      projectId: VALID_UUID,
      title: 't',
    });
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('munera_create_failed');
      expect(result.detail).toContain('boom');
    }
  });
});
