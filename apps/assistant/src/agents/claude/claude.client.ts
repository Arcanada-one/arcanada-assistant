import CircuitBreaker from 'opossum';

import {
  ClaudeCompletionRequestSchema,
  ClaudeResultSchema,
  McExecuteErrorEnvelopeSchema,
  McExecuteSuccessSchema,
  type ClaudeCompletionRequest,
  type ClaudeResult,
} from './claude.schemas.js';

export interface ClaudeLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug?(obj: Record<string, unknown>, msg?: string): void;
}

export interface ClaudeRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface ClaudeCircuitOptions {
  volumeThreshold: number;
  errorThresholdPercentage: number;
  rollingCountTimeout: number;
  resetTimeout: number;
}

export interface ClaudeClientOptions {
  baseUrl: string;
  apiKey: string;
  logger?: ClaudeLogger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retry?: ClaudeRetryOptions;
  circuit?: ClaudeCircuitOptions;
  defaultModel?: string;
  /** Connector name on MC side — defaults to `openrouter`. */
  connector?: string;
}

export interface IClaudeClient {
  complete(req: ClaudeCompletionRequest): Promise<ClaudeResult>;
  isCircuitOpen(): boolean;
}

export class ClaudeClientError extends Error {
  readonly cause?: unknown;
  readonly httpStatus?: number;
  readonly errorCode?: string;
  constructor(
    message: string,
    opts?: { cause?: unknown; httpStatus?: number; errorCode?: string },
  ) {
    super(message);
    this.name = 'ClaudeClientError';
    this.cause = opts?.cause;
    this.httpStatus = opts?.httpStatus;
    this.errorCode = opts?.errorCode;
  }
}

interface HttpResult {
  status: number;
  body: unknown;
}

const DEFAULT_CIRCUIT: ClaudeCircuitOptions = {
  volumeThreshold: 5,
  errorThresholdPercentage: 99,
  rollingCountTimeout: 30_000,
  resetTimeout: 60_000,
};

const DEFAULT_RETRY: ClaudeRetryOptions = { maxAttempts: 2, baseDelayMs: 250 };

const EXECUTE_PATH = '/execute';

export class ClaudeClient implements IClaudeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retry: ClaudeRetryOptions;
  private readonly defaultModel?: string;
  private readonly connector: string;
  private readonly breaker: CircuitBreaker<[ClaudeCompletionRequest], ClaudeResult>;

  constructor(opts: ClaudeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.defaultModel = opts.defaultModel;
    this.connector = opts.connector ?? 'openrouter';
    const cb = opts.circuit ?? DEFAULT_CIRCUIT;
    this.breaker = new CircuitBreaker(this.executeWithRetry.bind(this), {
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

  async complete(req: ClaudeCompletionRequest): Promise<ClaudeResult> {
    const parsed = ClaudeCompletionRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw new ClaudeClientError(`Invalid claude completion request: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }
    try {
      return await this.breaker.fire(parsed.data);
    } catch (err) {
      if (this.breaker.opened) {
        const msg = err instanceof Error ? err.message : String(err);
        return ClaudeResultSchema.parse({
          kind: 'unavailable',
          reason: 'claude_circuit_open',
          detail: msg,
        });
      }
      if (err instanceof ClaudeClientError && isClientFault(err)) {
        return ClaudeResultSchema.parse({
          kind: 'unavailable',
          reason: classifyReason(err),
          statusCode: err.httpStatus,
          errorCode: err.errorCode,
          detail: err.message,
        });
      }
      throw err;
    }
  }

  private async executeWithRetry(req: ClaudeCompletionRequest): Promise<ClaudeResult> {
    const attempts = this.retry.maxAttempts + 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.callOnce(req);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === attempts) break;
        const backoff = this.retry.baseDelayMs * 3 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr instanceof Error ? lastErr : new ClaudeClientError(String(lastErr));
  }

  private async callOnce(req: ClaudeCompletionRequest): Promise<ClaudeResult> {
    const url = `${this.baseUrl}${EXECUTE_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body: Record<string, unknown> = {
        connector: this.connector,
        prompt: req.content,
        systemPrompt: req.systemPrompt,
        model: req.model ?? this.defaultModel,
      };
      if (req.maxTokens !== undefined) {
        body.extra = { max_tokens: req.maxTokens };
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      };
      if (req.requestId) headers['x-request-id'] = req.requestId;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const result = await readJson(res);
      return this.mapResponse(result, req);
    } finally {
      clearTimeout(timer);
    }
  }

  private mapResponse(result: HttpResult, _req: ClaudeCompletionRequest): ClaudeResult {
    // Try ConnectorResponse shape first — MC's controller wraps both 2xx
    // success and 4xx errors that carry a connector error type (e.g.
    // `unsupported_modality` → HTTP 400 + full ConnectorResponse body).
    const connectorEnv = McExecuteSuccessSchema.safeParse(result.body);
    if (connectorEnv.success) {
      const env = connectorEnv.data;
      if (env.status === 'success') {
        return ClaudeResultSchema.parse({
          kind: 'ok',
          reply: env.result,
          model: env.model,
          inputTokens: env.usage.inputTokens,
          outputTokens: env.usage.outputTokens,
          totalTokens: env.usage.totalTokens,
          costUsd: env.usage.costUsd,
          latencyMs: env.latencyMs,
          requestId: env.id,
        });
      }
      const err = env.error;
      if (err?.type === 'unsupported_modality') {
        return ClaudeResultSchema.parse({
          kind: 'unavailable',
          reason: 'claude_unsupported_modality',
          statusCode: result.status,
          errorCode: err.type,
          detail: err.message,
        });
      }
      throw new ClaudeClientError(err?.message ?? `MC status ${env.status}`, {
        httpStatus: result.status,
        errorCode: err?.type ?? env.status,
      });
    }
    if (result.status >= 200 && result.status < 300) {
      throw new ClaudeClientError('Invalid MC success envelope', {
        cause: connectorEnv.error,
        httpStatus: result.status,
      });
    }
    const mcErr = McExecuteErrorEnvelopeSchema.safeParse(result.body);
    if (mcErr.success) {
      throw new ClaudeClientError(mcErr.data.message, {
        httpStatus: result.status,
        errorCode: mcErr.data.error_code,
      });
    }
    if (result.status === 401) {
      throw new ClaudeClientError('MC rejected api key', {
        httpStatus: 401,
        errorCode: 'unauthorized',
      });
    }
    throw new ClaudeClientError(`HTTP ${result.status}: ${truncate(result.body)}`, {
      httpStatus: result.status,
    });
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

function isClientFault(err: unknown): boolean {
  if (!(err instanceof ClaudeClientError)) return false;
  const s = err.httpStatus;
  if (s === undefined) return false;
  return s >= 400 && s < 500 && s !== 408 && s !== 429;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof ClaudeClientError)) return true;
  const s = err.httpStatus;
  if (s === undefined) return true;
  return s >= 500 || s === 408 || s === 429;
}

function classifyReason(err: ClaudeClientError): string {
  if (err.errorCode === 'unauthorized') return 'claude_unauthorized';
  if (err.errorCode === 'validation_error') return 'claude_validation_error';
  if (err.errorCode === 'unsupported_modality') return 'claude_unsupported_modality';
  if (err.errorCode === 'budget_exceeded') return 'claude_budget_exceeded';
  return `claude_${err.errorCode ?? 'client_error'}`;
}
