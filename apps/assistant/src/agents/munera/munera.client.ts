import CircuitBreaker from 'opossum';

import {
  CreateTaskRequestSchema,
  MuneraApiKeyUnauthorizedEnvelopeSchema,
  MuneraGlobalErrorEnvelopeSchema,
  MuneraJwtUnauthorizedEnvelopeSchema,
  MuneraTaskListSchema,
  MuneraTaskSchema,
  TaskListResultSchema,
  TaskResultSchema,
  UpdateTaskStatusRequestSchema,
  type CreateTaskRequest,
  type TaskListResult,
  type TaskResult,
  type UpdateTaskStatusRequest,
} from './munera.schemas.js';

export interface MuneraLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug?(obj: Record<string, unknown>, msg?: string): void;
}

export interface MuneraRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface MuneraCircuitOptions {
  volumeThreshold: number;
  errorThresholdPercentage: number;
  rollingCountTimeout: number;
  resetTimeout: number;
}

export interface MuneraClientOptions {
  /**
   * Munera base URL — e.g. `http://localhost:3500` (Assistant co-located with
   * Munera on PROD; Munera bound `127.0.0.1:3500`). External URL
   * `https://muneral.com` available via nginx but should not be used
   * intra-host (extra TLS hop + Cloudflare).
   */
  baseUrl: string;
  /**
   * Bearer JWT issued via Munera `POST /api/v1/auth/telegram` (or, post
   * AUTH-* migration, Auth Arcana OIDC client_credentials). Stored in Vault
   * `secret/munera/assistant-token` and refreshed by M7 hybrid-auth path.
   */
  apiToken: string;
  logger?: MuneraLogger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retry?: MuneraRetryOptions;
  circuit?: MuneraCircuitOptions;
  serviceName?: string;
}

export interface IMuneraClient {
  createTask(req: CreateTaskRequest): Promise<TaskResult>;
  updateTaskStatus(taskId: string, req: UpdateTaskStatusRequest): Promise<TaskResult>;
  getTask(taskId: string): Promise<TaskResult>;
  listTasksByProject(projectId: string): Promise<TaskListResult>;
  isCircuitOpen(): boolean;
}

export class MuneraClientError extends Error {
  readonly cause?: unknown;
  readonly httpStatus?: number;
  readonly errorCode?: string;
  constructor(
    message: string,
    opts?: { cause?: unknown; httpStatus?: number; errorCode?: string },
  ) {
    super(message);
    this.name = 'MuneraClientError';
    this.cause = opts?.cause;
    this.httpStatus = opts?.httpStatus;
    this.errorCode = opts?.errorCode;
  }
}

interface RequestPlan {
  url: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body: string | null;
  retryable: boolean;
}

interface HttpResult {
  status: number;
  body: unknown;
}

const DEFAULT_CIRCUIT: MuneraCircuitOptions = {
  volumeThreshold: 5,
  errorThresholdPercentage: 99,
  rollingCountTimeout: 30_000,
  resetTimeout: 60_000,
};

const DEFAULT_RETRY: MuneraRetryOptions = { maxAttempts: 2, baseDelayMs: 200 };

const TASKS_PATH = '/api/v1/tasks';

export class MuneraClient implements IMuneraClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly logger?: MuneraLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retry: MuneraRetryOptions;
  private readonly serviceName: string;
  private readonly breaker: CircuitBreaker<[RequestPlan], HttpResult>;

  constructor(opts: MuneraClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiToken = opts.apiToken;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.serviceName = opts.serviceName ?? 'arcanada-assistant';
    const cb = opts.circuit ?? DEFAULT_CIRCUIT;
    this.breaker = new CircuitBreaker(this.executeRequest.bind(this), {
      timeout: false,
      volumeThreshold: cb.volumeThreshold,
      errorThresholdPercentage: cb.errorThresholdPercentage,
      rollingCountTimeout: cb.rollingCountTimeout,
      resetTimeout: cb.resetTimeout,
      errorFilter: (err: unknown) => isClientFault(err),
    });
  }

  isCircuitOpen(): boolean {
    return this.breaker.opened;
  }

  async createTask(req: CreateTaskRequest): Promise<TaskResult> {
    const parsed = CreateTaskRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw new MuneraClientError(`Invalid createTask request: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }
    return this.callTaskEndpoint({
      url: `${this.baseUrl}${TASKS_PATH}`,
      method: 'POST',
      body: JSON.stringify(parsed.data),
      retryable: false,
    });
  }

  async updateTaskStatus(taskId: string, req: UpdateTaskStatusRequest): Promise<TaskResult> {
    if (!isUuid(taskId)) {
      throw new MuneraClientError(`Invalid taskId: ${taskId}`);
    }
    const parsed = UpdateTaskStatusRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw new MuneraClientError(`Invalid updateTaskStatus request: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }
    return this.callTaskEndpoint({
      url: `${this.baseUrl}${TASKS_PATH}/${taskId}/status`,
      method: 'PATCH',
      body: JSON.stringify(parsed.data),
      retryable: false,
    });
  }

  async getTask(taskId: string): Promise<TaskResult> {
    if (!isUuid(taskId)) {
      throw new MuneraClientError(`Invalid taskId: ${taskId}`);
    }
    return this.callTaskEndpoint({
      url: `${this.baseUrl}${TASKS_PATH}/${taskId}`,
      method: 'GET',
      body: null,
      retryable: true,
    });
  }

  async listTasksByProject(projectId: string): Promise<TaskListResult> {
    if (!isUuid(projectId)) {
      throw new MuneraClientError(`Invalid projectId: ${projectId}`);
    }
    try {
      const result = await this.breaker.fire({
        url: `${this.baseUrl}${TASKS_PATH}/project/${projectId}`,
        method: 'GET',
        body: null,
        retryable: true,
      });
      return this.mapListResponse(result);
    } catch (err) {
      return TaskListResultSchema.parse(this.buildUnavailable(err, 'task_list'));
    }
  }

  private async callTaskEndpoint(req: RequestPlan): Promise<TaskResult> {
    try {
      const result = await this.breaker.fire(req);
      return this.mapTaskResponse(result);
    } catch (err) {
      return TaskResultSchema.parse(this.buildUnavailable(err, 'task_call'));
    }
  }

  private buildUnavailable(err: unknown, operationLabel: string): {
    kind: 'unavailable';
    reason: string;
    statusCode?: number;
    errorCode?: string;
    detail?: string;
  } {
    if (this.breaker.opened) {
      return {
        kind: 'unavailable',
        reason: 'munera_circuit_open',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (err instanceof MuneraClientError && isClientFault(err)) {
      return {
        kind: 'unavailable',
        reason: classifyReason(err, operationLabel),
        ...(err.httpStatus !== undefined ? { statusCode: err.httpStatus } : {}),
        ...(err.errorCode ? { errorCode: err.errorCode } : {}),
        detail: err.message,
      };
    }
    if (err instanceof MuneraClientError) {
      return {
        kind: 'unavailable',
        reason: 'munera_error',
        ...(err.httpStatus !== undefined ? { statusCode: err.httpStatus } : {}),
        ...(err.errorCode ? { errorCode: err.errorCode } : {}),
        detail: err.message,
      };
    }
    return {
      kind: 'unavailable',
      reason: 'munera_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  private mapTaskResponse(result: HttpResult): TaskResult {
    if (result.status >= 200 && result.status < 300) {
      const parsed = MuneraTaskSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new MuneraClientError(
          `Invalid Munera task envelope: ${parsed.error.message}`,
          { cause: parsed.error, httpStatus: result.status },
        );
      }
      return TaskResultSchema.parse({ kind: 'ok', task: parsed.data });
    }
    throw this.classifyHttpError(result);
  }

  private mapListResponse(result: HttpResult): TaskListResult {
    if (result.status >= 200 && result.status < 300) {
      const parsed = MuneraTaskListSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new MuneraClientError(
          `Invalid Munera task list envelope: ${parsed.error.message}`,
          { cause: parsed.error, httpStatus: result.status },
        );
      }
      return TaskListResultSchema.parse({ kind: 'ok', tasks: parsed.data });
    }
    throw this.classifyHttpError(result);
  }

  private classifyHttpError(result: HttpResult): MuneraClientError {
    const jwt401 = MuneraJwtUnauthorizedEnvelopeSchema.safeParse(result.body);
    if (jwt401.success) {
      return new MuneraClientError(jwt401.data.message, {
        httpStatus: result.status,
        errorCode: 'jwt_unauthorized',
      });
    }
    const apiKey401 = MuneraApiKeyUnauthorizedEnvelopeSchema.safeParse(result.body);
    if (apiKey401.success) {
      return new MuneraClientError(apiKey401.data.message, {
        httpStatus: result.status,
        errorCode: 'api_key_unauthorized',
      });
    }
    const global = MuneraGlobalErrorEnvelopeSchema.safeParse(result.body);
    if (global.success) {
      const msg = Array.isArray(global.data.message)
        ? global.data.message.join('; ')
        : global.data.message;
      return new MuneraClientError(msg, {
        httpStatus: result.status,
        errorCode: errorCodeFromGlobal(global.data.error, result.status),
      });
    }
    return new MuneraClientError(`HTTP ${result.status}: ${truncate(result.body)}`, {
      httpStatus: result.status,
    });
  }

  private async executeRequest(req: RequestPlan): Promise<HttpResult> {
    const attempts = req.retryable ? this.retry.maxAttempts + 1 : 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.doFetch(req);
      } catch (err) {
        lastErr = err;
        if (!req.retryable || attempt === attempts || !isRetryable(err)) break;
        const backoff = this.retry.baseDelayMs * 3 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr instanceof Error ? lastErr : new MuneraClientError(String(lastErr));
  }

  private async doFetch(req: RequestPlan): Promise<HttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiToken}`,
      };
      if (req.body !== null) headers['content-type'] = 'application/json';
      const res = await this.fetchImpl(req.url, {
        method: req.method,
        headers,
        body: req.body ?? undefined,
        signal: controller.signal,
      });
      const result = await readJson(res);
      if (result.status >= 500 || result.status === 408 || result.status === 429) {
        this.logger?.warn(
          {
            status: result.status,
            method: req.method,
            url: req.url,
            service: this.serviceName,
          },
          'munera non-2xx (breaker-tripping)',
        );
        throw new MuneraClientError(
          `HTTP ${result.status} (${req.method} ${req.url}): ${truncate(result.body)}`,
          { httpStatus: result.status },
        );
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readJson(res: Response): Promise<HttpResult> {
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') && text ? safeParseJson(text) : text;
  return { status: res.status, body };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function truncate(body: unknown): string {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isClientFault(err: unknown): boolean {
  if (!(err instanceof MuneraClientError)) return false;
  const s = err.httpStatus;
  if (s === undefined) return false;
  return s >= 400 && s < 500 && s !== 408 && s !== 429;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof MuneraClientError)) return true;
  const s = err.httpStatus;
  if (s === undefined) return true;
  return s >= 500 || s === 408 || s === 429;
}

function classifyReason(err: MuneraClientError, operationLabel: string): string {
  if (err.errorCode === 'jwt_unauthorized') return 'munera_jwt_unauthorized';
  if (err.errorCode === 'api_key_unauthorized') return 'munera_api_key_unauthorized';
  if (err.errorCode === 'not_found') return 'munera_not_found';
  if (err.errorCode === 'forbidden') return 'munera_forbidden';
  if (err.errorCode === 'bad_request') return `munera_${operationLabel}_validation_error`;
  return `munera_${err.errorCode ?? operationLabel}_failed`;
}

function errorCodeFromGlobal(error: string, status: number): string {
  if (status === 400 || /Bad Request/i.test(error)) return 'bad_request';
  if (status === 403 || /Forbidden/i.test(error)) return 'forbidden';
  if (status === 404 || /Not Found/i.test(error)) return 'not_found';
  if (status === 409 || /Conflict/i.test(error)) return 'conflict';
  if (status === 422 || /Unprocessable/i.test(error)) return 'unprocessable_entity';
  return `http_${status}`;
}
