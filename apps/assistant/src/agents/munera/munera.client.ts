import CircuitBreaker from 'opossum';

import {
  CreateTaskRequestSchema,
  MuneraApiKeyUnauthorizedEnvelopeSchema,
  MuneraGlobalErrorEnvelopeSchema,
  MuneraJwtUnauthorizedEnvelopeSchema,
  MuneraTaskListSchema,
  MuneraTaskPageSchema,
  MuneraTaskQuerySchema,
  MuneraTaskSchema,
  TaskListResultSchema,
  TaskPageResultSchema,
  TaskResultSchema,
  UpdateTaskStatusRequestSchema,
  type CreateTaskRequest,
  type MuneraTaskQuery,
  type TaskListResult,
  type TaskPageResult,
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
   * The credential sent as `Authorization: Bearer <apiToken>`. Muneral accepts
   * two kinds on the same header and nothing else (`JwtOrApiKeyGuard`): a user
   * JWT, or an agent key with the `mun_sk_` prefix.
   *
   * A2-281 — an unattended process holds the AGENT KEY, read from the file
   * named by `MUNERAL_AGENT_KEY_FILE`, never a value in the environment. What
   * the key may reach is narrower than a JWT: `AgentTaskScopeGuard` refuses an
   * API key on every route not explicitly marked `@AgentScope(...)`. See
   * `MuneralWorkItemsReader` for the one route this matters on.
   */
  apiToken: string;
  logger?: MuneraLogger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retry?: MuneraRetryOptions;
  circuit?: MuneraCircuitOptions;
  serviceName?: string;
  /**
   * A2-281 — AGENTS.md § Operating rules requires `aup-orchestrator/1.0` on
   * every Muneral call, and this client sent no User-Agent at all, so its
   * traffic was indistinguishable from a stray curl in any access log.
   */
  userAgent?: string;
}

export interface IMuneraClient {
  createTask(req: CreateTaskRequest): Promise<TaskResult>;
  updateTaskStatus(taskId: string, req: UpdateTaskStatusRequest): Promise<TaskResult>;
  getTask(taskId: string): Promise<TaskResult>;
  listTasksByProject(projectId: string): Promise<TaskListResult>;
  queryTasks(query: MuneraTaskQuery): Promise<TaskPageResult>;
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

/**
 * A2-281 — the canonical Muneral address in AGENTS.md is
 * `https://api.muneral.com/api/v1`, but every path in this client already
 * carries `/api/v1`. Configuring the canonical form therefore produced
 * `…/api/v1/api/v1/tasks` and a 404 that looks exactly like an empty board.
 * Both spellings are accepted and normalised to the origin.
 */
export function normaliseMuneraBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

export const DEFAULT_MUNERA_USER_AGENT = 'aup-orchestrator/1.0';

export class MuneraClient implements IMuneraClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly logger?: MuneraLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retry: MuneraRetryOptions;
  private readonly serviceName: string;
  private readonly userAgent: string;
  private readonly breaker: CircuitBreaker<[RequestPlan], HttpResult>;

  constructor(opts: MuneraClientOptions) {
    this.baseUrl = normaliseMuneraBaseUrl(opts.baseUrl);
    this.apiToken = opts.apiToken;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.serviceName = opts.serviceName ?? 'arcanada-assistant';
    this.userAgent = opts.userAgent ?? DEFAULT_MUNERA_USER_AGENT;
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

  /**
   * A2-281 — `GET /api/v1/tasks`, the cross-project filter Muneral added for
   * exactly this consumer: "what is in progress", "what reached done today",
   * "what is queued" without enumerating projects and without reading a
   * Markdown snapshot off a disk.
   *
   * Returns `unavailable` with the HTTP status for anything that is not a
   * well-formed 2xx page. It never degrades to an empty list: a 401/403 and
   * "no work items matched" are different answers and the caller renders them
   * differently.
   */
  async queryTasks(query: MuneraTaskQuery): Promise<TaskPageResult> {
    const parsed = MuneraTaskQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new MuneraClientError(`Invalid queryTasks request: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const qs = search.toString();
    try {
      const result = await this.breaker.fire({
        url: `${this.baseUrl}${TASKS_PATH}${qs ? `?${qs}` : ''}`,
        method: 'GET',
        body: null,
        retryable: true,
      });
      return this.mapPageResponse(result);
    } catch (err) {
      return TaskPageResultSchema.parse(this.buildUnavailable(err, 'task_query'));
    }
  }

  private mapPageResponse(result: HttpResult): TaskPageResult {
    if (result.status >= 200 && result.status < 300) {
      const parsed = MuneraTaskPageSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new MuneraClientError(`Invalid Munera task page envelope: ${parsed.error.message}`, {
          cause: parsed.error,
          httpStatus: result.status,
        });
      }
      return TaskPageResultSchema.parse({ kind: 'ok', page: parsed.data });
    }
    throw this.classifyHttpError(result);
  }

  private async callTaskEndpoint(req: RequestPlan): Promise<TaskResult> {
    try {
      const result = await this.breaker.fire(req);
      return this.mapTaskResponse(result);
    } catch (err) {
      return TaskResultSchema.parse(this.buildUnavailable(err, 'task_call'));
    }
  }

  private buildUnavailable(
    err: unknown,
    operationLabel: string,
  ): {
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
        throw new MuneraClientError(`Invalid Munera task envelope: ${parsed.error.message}`, {
          cause: parsed.error,
          httpStatus: result.status,
        });
      }
      return TaskResultSchema.parse({ kind: 'ok', task: parsed.data });
    }
    throw this.classifyHttpError(result);
  }

  private mapListResponse(result: HttpResult): TaskListResult {
    if (result.status >= 200 && result.status < 300) {
      const parsed = MuneraTaskListSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new MuneraClientError(`Invalid Munera task list envelope: ${parsed.error.message}`, {
          cause: parsed.error,
          httpStatus: result.status,
        });
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
        'user-agent': this.userAgent,
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
