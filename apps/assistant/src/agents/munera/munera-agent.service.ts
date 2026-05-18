import { Inject, Injectable } from '@nestjs/common';

import type { IAgent } from '../../orchestrator/agent.registry.js';
import type { AgentHealthSnapshot, IAgentHealth } from '../../aal/agent-health.types.js';

import type { IMuneraClient } from './munera.client.js';
import type {
  CreateTaskRequest,
  TaskListResult,
  TaskResult,
  UpdateTaskStatusRequest,
} from './munera.schemas.js';

export const MUNERA_CLIENT = Symbol.for('MUNERA_CLIENT');

export const MUNERA_INTENT_TASK_CREATE = '/task_create';
export const MUNERA_INTENT_TASK_UPDATE = '/task_update';
export const MUNERA_INTENT_TASK_GET = '/task_get';
export const MUNERA_INTENT_TASK_LIST = '/task_list';

export interface TaskUpdatePayload extends UpdateTaskStatusRequest {
  taskId: string;
}

export interface TaskGetPayload {
  taskId: string;
}

export interface TaskListPayload {
  projectId: string;
}

export type MuneraAgentResult = TaskResult | TaskListResult;

@Injectable()
export class MuneraAgentService implements IAgent, IAgentHealth {
  readonly name = 'munera';
  readonly intents = [
    MUNERA_INTENT_TASK_CREATE,
    MUNERA_INTENT_TASK_UPDATE,
    MUNERA_INTENT_TASK_GET,
    MUNERA_INTENT_TASK_LIST,
  ] as const;

  constructor(@Inject(MUNERA_CLIENT) private readonly client: IMuneraClient) {}

  healthSnapshot(): AgentHealthSnapshot {
    const open = this.client.isCircuitOpen();
    return {
      agent: this.name,
      state: open ? 'unavailable' : 'ok',
      circuit: open ? 'open' : 'closed',
      ...(open ? { reason: 'circuit_open' } : {}),
      checkedAt: new Date().toISOString(),
    };
  }

  async execute(intent: string, payload?: unknown): Promise<MuneraAgentResult> {
    if (this.client.isCircuitOpen()) {
      return {
        kind: 'unavailable',
        reason: 'munera_circuit_open',
      };
    }
    switch (intent) {
      case MUNERA_INTENT_TASK_CREATE:
        return this.runCreate(payload);
      case MUNERA_INTENT_TASK_UPDATE:
        return this.runUpdate(payload);
      case MUNERA_INTENT_TASK_GET:
        return this.runGet(payload);
      case MUNERA_INTENT_TASK_LIST:
        return this.runList(payload);
      default:
        throw new Error(`MuneraAgent does not handle intent "${intent}"`);
    }
  }

  private async runCreate(payload: unknown): Promise<TaskResult> {
    if (!isObject(payload)) {
      return invalidPayload('munera_invalid_create_payload', 'payload must be an object');
    }
    try {
      return await this.client.createTask(payload as CreateTaskRequest);
    } catch (err) {
      return errorToUnavailable(err, 'munera_create_failed');
    }
  }

  private async runUpdate(payload: unknown): Promise<TaskResult> {
    if (!isObject(payload) || typeof (payload as { taskId?: unknown }).taskId !== 'string') {
      return invalidPayload('munera_invalid_update_payload', 'payload requires taskId (string)');
    }
    const typed = payload as unknown as TaskUpdatePayload;
    const { taskId, ...rest } = typed;
    try {
      return await this.client.updateTaskStatus(taskId, rest as UpdateTaskStatusRequest);
    } catch (err) {
      return errorToUnavailable(err, 'munera_update_failed');
    }
  }

  private async runGet(payload: unknown): Promise<TaskResult> {
    if (!isObject(payload) || typeof (payload as { taskId?: unknown }).taskId !== 'string') {
      return invalidPayload('munera_invalid_get_payload', 'payload requires taskId (string)');
    }
    try {
      return await this.client.getTask((payload as unknown as TaskGetPayload).taskId);
    } catch (err) {
      return errorToUnavailable(err, 'munera_get_failed');
    }
  }

  private async runList(payload: unknown): Promise<TaskListResult> {
    if (!isObject(payload) || typeof (payload as { projectId?: unknown }).projectId !== 'string') {
      return invalidListPayload('payload requires projectId (string)');
    }
    try {
      return await this.client.listTasksByProject(
        (payload as unknown as TaskListPayload).projectId,
      );
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: 'munera_list_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function invalidPayload(reason: string, detail: string): TaskResult {
  return { kind: 'unavailable', reason, detail };
}

function invalidListPayload(detail: string): TaskListResult {
  return { kind: 'unavailable', reason: 'munera_invalid_list_payload', detail };
}

function errorToUnavailable(err: unknown, fallbackReason: string): TaskResult {
  return {
    kind: 'unavailable',
    reason: fallbackReason,
    detail: err instanceof Error ? err.message : String(err),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
