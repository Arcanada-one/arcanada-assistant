import CircuitBreaker from 'opossum';

import {
  HealthResponseSchema,
  IngestRequestSchema,
  IngestResultSchema,
  RecallRequestSchema,
  RecallResultSchema,
  SearchRequestSchema,
  SearchResultSchema,
  type IngestRequest,
  type IngestResult,
  type PingResult,
  type RecallRequest,
  type RecallResult,
  type SearchRequest,
  type SearchResult,
} from './scrutator.types.js';

export interface ScrutatorLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug?(obj: Record<string, unknown>, msg?: string): void;
}

export interface ScrutatorRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface ScrutatorCircuitOptions {
  volumeThreshold: number;
  errorThresholdPercentage: number;
  rollingCountTimeout: number;
  resetTimeout: number;
}

/**
 * Self-heal event payload emitted by the Scrutator client when its circuit
 * breaker recovers (close transition). Consumers wire this to Ops Bot
 * `POST /events` via an injected emitter — keeps `packages/core` free of any
 * Ops Bot HTTP dependency while still satisfying AAL Mandate § 8.
 *
 * Per PRD-ARCA-0009 V-AC-19, the payload MUST contain:
 *   `{component: 'scrutator-client', level_attempted: 'L4',
 *     fix_applied: 'cb-recovered', outcome: 'ok'}`.
 */
export interface ScrutatorSelfHealPayload {
  readonly component: 'scrutator-client';
  readonly level_attempted: 'L4';
  readonly fix_applied: 'cb-recovered';
  readonly outcome: 'ok';
  readonly state: 'close';
}

export type ScrutatorSelfHealEmitter = (payload: ScrutatorSelfHealPayload) => void | Promise<void>;

export interface ScrutatorClientOptions {
  /**
   * Base URL — e.g. `http://arcana-db:8310` (Tailscale-only network policy
   * authenticates inbound; no `Authorization` header is sent). HTTPS
   * preferred where available; fixture probe of v0.3.0 runs over plain HTTP
   * on the Tailscale CGNAT range.
   */
  baseUrl: string;
  logger?: ScrutatorLogger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  healthTimeoutMs?: number;
  retry?: ScrutatorRetryOptions;
  circuit?: ScrutatorCircuitOptions;
  /** Service identity for log lines. */
  serviceName?: string;
  /**
   * Optional emitter invoked when the circuit breaker recovers (`close`).
   * When wired to Ops Bot, satisfies ARCA-0102 / V-AC-19. Default: no-op.
   */
  selfHealEmit?: ScrutatorSelfHealEmitter;
  /** If false, the `close` event is not surfaced to the emitter. Default true. */
  emitSelfHealOnRecovery?: boolean;
}

export interface IScrutatorClient {
  ping(): Promise<PingResult>;
  searchWiki(req: SearchRequest): Promise<SearchResult>;
  ingestLtm(req: IngestRequest): Promise<IngestResult>;
  recallLtm(req: RecallRequest): Promise<RecallResult>;
  isCircuitOpen(): boolean;
}

export class ScrutatorClientError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ScrutatorClientError';
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

const DEFAULT_CIRCUIT: ScrutatorCircuitOptions = {
  volumeThreshold: 5,
  errorThresholdPercentage: 99,
  rollingCountTimeout: 30_000,
  resetTimeout: 60_000,
};

const DEFAULT_RETRY: ScrutatorRetryOptions = { maxAttempts: 2, baseDelayMs: 200 };

const INGEST_FAILED_DETAIL = 'Ingest failed';

export class ScrutatorClient implements IScrutatorClient {
  private readonly baseUrl: string;
  private readonly logger?: ScrutatorLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly retry: ScrutatorRetryOptions;
  private readonly serviceName: string;
  private readonly selfHealEmit?: ScrutatorSelfHealEmitter;
  private readonly emitSelfHealOnRecovery: boolean;
  private readonly breaker: CircuitBreaker<[RequestPlan], HttpResult>;

  constructor(opts: ScrutatorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 2_000;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.serviceName = opts.serviceName ?? 'arcanada-assistant';
    this.selfHealEmit = opts.selfHealEmit;
    this.emitSelfHealOnRecovery = opts.emitSelfHealOnRecovery ?? true;
    const cb = opts.circuit ?? DEFAULT_CIRCUIT;
    this.breaker = new CircuitBreaker(this.executeRequest.bind(this), {
      timeout: false,
      volumeThreshold: cb.volumeThreshold,
      errorThresholdPercentage: cb.errorThresholdPercentage,
      rollingCountTimeout: cb.rollingCountTimeout,
      resetTimeout: cb.resetTimeout,
      errorFilter: (err: unknown) => isExcludedClientError(err),
    });
    this.breaker.on('close', () => {
      if (!this.emitSelfHealOnRecovery || !this.selfHealEmit) return;
      const payload: ScrutatorSelfHealPayload = {
        component: 'scrutator-client',
        level_attempted: 'L4',
        fix_applied: 'cb-recovered',
        outcome: 'ok',
        state: 'close',
      };
      try {
        const out = this.selfHealEmit(payload);
        if (out && typeof (out as Promise<void>).then === 'function') {
          (out as Promise<void>).catch((err) =>
            this.logger?.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'scrutator self_heal recovery emit failed (non-fatal)',
            ),
          );
        }
      } catch (err) {
        this.logger?.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'scrutator self_heal recovery emit threw (non-fatal)',
        );
      }
    });
  }

  isCircuitOpen(): boolean {
    return this.breaker.opened;
  }

  async ping(): Promise<PingResult> {
    const start = Date.now();
    try {
      const result = await this.executeRequest({
        url: `${this.baseUrl}/health`,
        method: 'GET',
        body: null,
        retryable: false,
        timeoutMs: this.healthTimeoutMs,
      });
      const latencyMs = Date.now() - start;
      const parsed = HealthResponseSchema.safeParse(result.json);
      if (!parsed.success) {
        return { ok: false, latencyMs, error: 'invalid health response shape' };
      }
      return { ok: parsed.data.status === 'ok', latencyMs, version: parsed.data.version };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async searchWiki(req: SearchRequest): Promise<SearchResult> {
    const parsed = SearchRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw new ScrutatorClientError(
        `Invalid search request: ${parsed.error.message}`,
        parsed.error,
      );
    }
    const result = await this.callBreaker({
      url: `${this.baseUrl}/v1/search`,
      method: 'POST',
      body: JSON.stringify(parsed.data),
      retryable: true,
      timeoutMs: this.timeoutMs,
    });
    const validated = SearchResultSchema.safeParse(result.json);
    if (!validated.success) {
      throw new ScrutatorClientError(
        `Invalid /v1/search response: ${validated.error.message}`,
        validated.error,
      );
    }
    return validated.data;
  }

  async ingestLtm(req: IngestRequest): Promise<IngestResult> {
    const parsed = IngestRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw new ScrutatorClientError(
        `Invalid ingest request: ${parsed.error.message}`,
        parsed.error,
      );
    }
    const result = await this.callBreaker({
      url: `${this.baseUrl}/v1/ltm/ingest`,
      method: 'POST',
      body: JSON.stringify(parsed.data),
      retryable: false,
      timeoutMs: this.timeoutMs,
    });
    // Scrutator soft-fail pattern: HTTP 200 + body `{detail: "Ingest failed"}`
    // while the chunk lands eventually. Treat as async-success.
    const body = result.json as Record<string, unknown> | undefined;
    if (body && typeof body === 'object' && body['detail'] === INGEST_FAILED_DETAIL) {
      this.logger?.warn(
        { source_path: parsed.data.source_path, namespace: parsed.data.namespace },
        'scrutator ingest soft-fail (200 + Ingest failed) — treated as async success',
      );
      const out: IngestResult = {
        ok: true,
        async: true,
        warning: 'scrutator-soft-fail',
      };
      return IngestResultSchema.parse(out);
    }
    const out: IngestResult = {
      ok: true,
      async: false,
      ...(body && typeof body === 'object' && typeof body['chunk_id'] === 'string'
        ? { chunk_id: body['chunk_id'] }
        : {}),
    };
    return IngestResultSchema.parse(out);
  }

  async recallLtm(req: RecallRequest): Promise<RecallResult> {
    const parsed = RecallRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw new ScrutatorClientError(
        `Invalid recall request: ${parsed.error.message}`,
        parsed.error,
      );
    }
    const result = await this.callBreaker({
      url: `${this.baseUrl}/v1/ltm/recall`,
      method: 'POST',
      body: JSON.stringify(parsed.data),
      retryable: true,
      timeoutMs: this.timeoutMs,
    });
    const validated = RecallResultSchema.safeParse(result.json);
    if (!validated.success) {
      throw new ScrutatorClientError(
        `Invalid /v1/ltm/recall response: ${validated.error.message}`,
        validated.error,
      );
    }
    return validated.data;
  }

  private async callBreaker(req: RequestPlan): Promise<HttpResult> {
    try {
      return await this.breaker.fire(req);
    } catch (err) {
      if (this.breaker.opened) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ScrutatorClientError(`circuit open: ${msg}`, err);
      }
      if (err instanceof ScrutatorClientError) throw err;
      throw new ScrutatorClientError(err instanceof Error ? err.message : String(err), err);
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
    throw lastErr instanceof Error ? lastErr : new ScrutatorClientError(String(lastErr));
  }

  private async doFetch(req: RequestPlan): Promise<HttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const headers: Record<string, string> = {};
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
          { status: res.status, method: req.method, url: req.url, service: this.serviceName },
          'scrutator non-2xx',
        );
        throw new ScrutatorClientError(
          `HTTP ${res.status} (${req.method} ${req.url}): ${text.slice(0, 200)}`,
        );
      }
      const json = contentType.includes('application/json') && text ? JSON.parse(text) : undefined;
      return { status: res.status, text, json };
    } finally {
      clearTimeout(timer);
    }
  }
}

const HTTP_CODE_RE = /^HTTP (\d+)/;

/**
 * Mirrors `ops-bot.client.ts` errorFilter: 4xx (auth/payload/not-found) are
 * application errors and propagate but do NOT trip the breaker; 408 + 429
 * (timeout / rate-limit) DO count, as they signal downstream pressure.
 */
function isExcludedClientError(err: unknown): boolean {
  if (!(err instanceof ScrutatorClientError)) return false;
  const match = HTTP_CODE_RE.exec(err.message);
  if (!match) return false;
  const code = Number(match[1]);
  return code >= 400 && code < 500 && code !== 408 && code !== 429;
}
