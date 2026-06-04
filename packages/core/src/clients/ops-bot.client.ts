import CircuitBreaker from 'opossum';
import type { Redis } from 'ioredis';

import {
  EcosystemSnapshotSchema,
  EmitEventInputSchema,
  EmitEventResponseSchema,
  ExecuteCommandInputSchema,
  ExecuteCommandResponseSchema,
  type EcosystemSnapshot,
  type EmitEventInput,
  type EmitEventResponse,
  type ExecuteCommandInput,
  type ExecuteCommandResponse,
} from './ops-bot.types.js';
import { parsePrometheusSnapshot } from './prometheus-parse.js';
import { HealthResponseSchema, type PingResult } from './scrutator.types.js';

export interface OpsBotLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug?(obj: Record<string, unknown>, msg?: string): void;
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface CircuitOptions {
  volumeThreshold: number;
  errorThresholdPercentage: number;
  rollingCountTimeout: number;
  resetTimeout: number;
}

export interface OpsBotClientOptions {
  baseUrl: string;
  apiKey: string;
  redis?: Redis;
  logger?: OpsBotLogger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  healthTimeoutMs?: number;
  cacheTtlMs?: number;
  cacheKey?: string;
  retry?: RetryOptions;
  circuit?: CircuitOptions;
  /** Service identity for emitted events (creative-ARCA-0005 line 301-308). */
  serviceName?: string;
  /**
   * If true, emits self_heal event when CB transitions to `close` (recovery).
   * Default true. Per creative-ARCA-0005 line 251-253 + AAL Mandate § 8.
   */
  emitSelfHealOnRecovery?: boolean;
}

export interface IOpsBotClient {
  emitEvent(input: EmitEventInput): Promise<EmitEventResponse>;
  getEcosystemSnapshot(): Promise<EcosystemSnapshot>;
  healthReady(): Promise<boolean>;
  /**
   * Structured liveness probe for the `/health` aggregation surface.
   * Wraps `GET /health/ready` and returns the canonical `PingResult` shape
   * (parity with `IScrutatorClient.ping`) so the assistant health controller can
   * report `latencyMs` / `error` rather than a bare boolean. Never throws — a
   * transport fault or non-2xx becomes `{ ok: false, latencyMs, error }`.
   */
  ping(): Promise<PingResult>;
  isCircuitOpen(): boolean;
  /**
   * Bidirectional command issue (ARCA-0009 M3, PRD V-AC-3). Emits pre-execute
   * and post-execute `audit` events around the call so threat-model T4
   * (unauthorised command execution + audit-gap) is closed end-to-end.
   * Idempotency is delegated to Ops Bot via the caller-supplied uuid v7
   * `idempotencyKey`; transport layer does NOT retry on 5xx.
   */
  executeCommand(input: ExecuteCommandInput): Promise<ExecuteCommandResponse>;
}

export class OpsBotClientError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OpsBotClientError';
    this.cause = cause;
  }
}

interface RequestPlan {
  url: string;
  method: 'GET' | 'POST';
  body: string | null;
  retryable: boolean;
  timeoutMs: number;
}

interface HttpResult {
  status: number;
  text: string;
  json?: unknown;
}

const DEFAULT_CIRCUIT: CircuitOptions = {
  volumeThreshold: 5,
  // opossum uses STRICT `>` against this percentage (lib/circuit.js line ~994);
  // 99 means 100% error rate (всё 5 из 5) trips, but 80% (4 из 5) does not.
  errorThresholdPercentage: 99,
  rollingCountTimeout: 30_000,
  resetTimeout: 60_000,
};

const DEFAULT_RETRY: RetryOptions = { maxAttempts: 2, baseDelayMs: 200 };

export class OpsBotClient implements IOpsBotClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly redis?: Redis;
  private readonly logger?: OpsBotLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cacheKey: string;
  private readonly retry: RetryOptions;
  private readonly serviceName: string;
  private readonly emitSelfHealOnRecovery: boolean;
  private readonly breaker: CircuitBreaker<[RequestPlan], HttpResult>;

  constructor(opts: OpsBotClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.redis = opts.redis;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 2_000;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.cacheKey = opts.cacheKey ?? 'assistant:opsbot-snapshot:last';
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.serviceName = opts.serviceName ?? 'arcanada-assistant';
    this.emitSelfHealOnRecovery = opts.emitSelfHealOnRecovery ?? true;
    const cb = opts.circuit ?? DEFAULT_CIRCUIT;
    this.breaker = new CircuitBreaker(this.executeRequest.bind(this), {
      timeout: false,
      volumeThreshold: cb.volumeThreshold,
      errorThresholdPercentage: cb.errorThresholdPercentage,
      rollingCountTimeout: cb.rollingCountTimeout,
      resetTimeout: cb.resetTimeout,
      // 4xx (auth/payload/not-found) — application errors, not transport faults;
      // do not count toward CB threshold. Exception: 408 timeout, 429 rate-limit
      // indicate downstream pressure → keep counting. Source: ARCA-0007 QA review.
      errorFilter: (err: unknown) => isExcludedClientError(err),
    });
    this.breaker.on('close', () => {
      if (this.emitSelfHealOnRecovery) void this.emitSelfHealRecovery();
    });
  }

  isCircuitOpen(): boolean {
    return this.breaker.opened;
  }

  async emitEvent(input: EmitEventInput): Promise<EmitEventResponse> {
    const parsed = EmitEventInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new OpsBotClientError(`Invalid event input: ${parsed.error.message}`, parsed.error);
    }
    const body = JSON.stringify({
      ...parsed.data,
      timestamp: parsed.data.timestamp ?? new Date().toISOString(),
    });
    const result = await this.callBreaker({
      url: `${this.baseUrl}/events`,
      method: 'POST',
      body,
      retryable: false,
      timeoutMs: this.timeoutMs,
    });
    const ack = EmitEventResponseSchema.safeParse(result.json);
    if (!ack.success) {
      throw new OpsBotClientError(`Invalid /events response: ${ack.error.message}`, ack.error);
    }
    return ack.data;
  }

  async getEcosystemSnapshot(): Promise<EcosystemSnapshot> {
    const cached = await this.readCache();
    if (cached) return cached;
    const result = await this.callBreaker({
      url: `${this.baseUrl}/metrics`,
      method: 'GET',
      body: null,
      retryable: true,
      timeoutMs: this.timeoutMs,
    });
    const snap = parsePrometheusSnapshot(result.text);
    const validated = EcosystemSnapshotSchema.safeParse(snap);
    if (!validated.success) {
      throw new OpsBotClientError(
        `Snapshot validation failed: ${validated.error.message}`,
        validated.error,
      );
    }
    await this.writeCache(validated.data);
    return validated.data;
  }

  async executeCommand(input: ExecuteCommandInput): Promise<ExecuteCommandResponse> {
    const parsed = ExecuteCommandInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new OpsBotClientError(
        `Invalid executeCommand input: ${parsed.error.message}`,
        parsed.error,
      );
    }
    const { cmd, payload, idempotencyKey } = parsed.data;
    await this.safeAuditEmit({
      message: 'opsbot-command-issued',
      context: { component: 'ops-bot-client', cmd, idempotency_key: idempotencyKey },
    });
    const body = JSON.stringify({
      cmd,
      payload,
      idempotency_key: idempotencyKey,
    });
    let response: ExecuteCommandResponse;
    try {
      const result = await this.callBreaker({
        url: `${this.baseUrl}/commands`,
        method: 'POST',
        body,
        retryable: false,
        timeoutMs: this.timeoutMs,
      });
      const ack = ExecuteCommandResponseSchema.safeParse(result.json);
      if (!ack.success) {
        throw new OpsBotClientError(`Invalid /commands response: ${ack.error.message}`, ack.error);
      }
      response = ack.data;
    } catch (err) {
      await this.safeAuditEmit({
        message: 'opsbot-command-error',
        context: {
          component: 'ops-bot-client',
          cmd,
          idempotency_key: idempotencyKey,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
    await this.safeAuditEmit({
      message: 'opsbot-command-result',
      context: {
        component: 'ops-bot-client',
        cmd,
        idempotency_key: idempotencyKey,
        ok: response.ok,
        command_id: response.command_id,
      },
    });
    return response;
  }

  async healthReady(): Promise<boolean> {
    try {
      const result = await this.executeRequest({
        url: `${this.baseUrl}/health/ready`,
        method: 'GET',
        body: null,
        retryable: false,
        timeoutMs: this.healthTimeoutMs,
      });
      return result.status >= 200 && result.status < 300;
    } catch {
      return false;
    }
  }

  async ping(): Promise<PingResult> {
    const start = Date.now();
    try {
      const result = await this.executeRequest({
        url: `${this.baseUrl}/health/ready`,
        method: 'GET',
        body: null,
        retryable: false,
        timeoutMs: this.healthTimeoutMs,
      });
      const latencyMs = Date.now() - start;
      // `/health/ready` returns `{ status, db, redis }`; a 2xx with no JSON body
      // (or a non-`ok` status field) is still a successful liveness signal —
      // mirror Scrutator's `status === 'ok'` check but fall back to the HTTP
      // code when the body is absent/un-shaped.
      const parsed = HealthResponseSchema.safeParse(result.json);
      const ok = parsed.success ? parsed.data.status === 'ok' : result.status >= 200 && result.status < 300;
      return { ok, latencyMs, ...(parsed.success && parsed.data.version ? { version: parsed.data.version } : {}) };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async callBreaker(req: RequestPlan): Promise<HttpResult> {
    try {
      return await this.breaker.fire(req);
    } catch (err) {
      if (this.breaker.opened) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new OpsBotClientError(`circuit open: ${msg}`, err);
      }
      if (err instanceof OpsBotClientError) throw err;
      throw new OpsBotClientError(err instanceof Error ? err.message : String(err), err);
    }
  }

  private async executeRequest(req: RequestPlan): Promise<HttpResult> {
    let lastErr: unknown;
    const attempts = req.retryable ? this.retry.maxAttempts + 1 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.doFetch(req);
      } catch (err) {
        lastErr = err;
        if (!req.retryable || attempt === attempts) break;
        const backoff = this.retry.baseDelayMs * 3 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr instanceof Error ? lastErr : new OpsBotClientError(String(lastErr));
  }

  private async doFetch(req: RequestPlan): Promise<HttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
      };
      if (req.body !== null) headers['content-type'] = 'application/json';
      const res = await this.fetchImpl(req.url, {
        method: req.method,
        headers,
        body: req.body ?? undefined,
        signal: controller.signal,
      });
      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();
      if (!res.ok) {
        this.logger?.warn(
          { status: res.status, method: req.method, url: req.url },
          'opsbot non-2xx',
        );
        throw new OpsBotClientError(
          `HTTP ${res.status} (${req.method} ${req.url}): ${text.slice(0, 200)}`,
        );
      }
      const json = contentType.includes('application/json') && text ? JSON.parse(text) : undefined;
      return { status: res.status, text, json };
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeAuditEmit(args: {
    message: string;
    context: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.emitEvent({
        service: this.serviceName,
        category: 'audit',
        severity: 'info',
        message: args.message,
        context: args.context,
      });
    } catch (err) {
      this.logger?.warn(
        { err: errMessage(err), message: args.message },
        'opsbot audit emit failed (non-fatal)',
      );
    }
  }

  private async emitSelfHealRecovery(): Promise<void> {
    try {
      await this.emitEvent({
        service: this.serviceName,
        category: 'self_heal',
        severity: 'info',
        message: 'ops-bot client circuit breaker recovered (close)',
        context: { component: 'ops-bot-client', state: 'close' },
      });
    } catch (err) {
      this.logger?.warn(
        { err: errMessage(err) },
        'opsbot self_heal recovery emit failed (non-fatal)',
      );
    }
  }

  private async readCache(): Promise<EcosystemSnapshot | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(this.cacheKey);
      if (!raw) return null;
      const parsed = EcosystemSnapshotSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (err) {
      this.logger?.warn({ err: errMessage(err) }, 'opsbot cache read failed');
      return null;
    }
  }

  private async writeCache(snap: EcosystemSnapshot): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(this.cacheKey, JSON.stringify(snap), 'PX', this.cacheTtlMs);
    } catch (err) {
      this.logger?.warn({ err: errMessage(err) }, 'opsbot cache write failed');
    }
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const HTTP_CODE_RE = /^HTTP (\d+)/;

/**
 * Returns true when the error should be skipped by the circuit breaker
 * (counted as «не fault, ОК-failure»). 4xx responses indicate application
 * mistakes (bad payload, missing key) — they should propagate to the caller
 * but should NOT trip the breaker. 408 (request timeout) and 429 (rate
 * limit) signal downstream load — they DO count.
 */
function isExcludedClientError(err: unknown): boolean {
  if (!(err instanceof OpsBotClientError)) return false;
  const match = HTTP_CODE_RE.exec(err.message);
  if (!match) return false;
  const code = Number(match[1]);
  return code >= 400 && code < 500 && code !== 408 && code !== 429;
}
