import { HealthResponseSchema, type PingResult } from './scrutator.types.js';

/**
 * Minimal, dependency-free liveness probe for upstreams that expose a
 * `GET {baseUrl}/health` endpoint returning `{ status, version? }`.
 *
 * Unlike `ScrutatorClient` / `OpsBotClient` this carries no circuit breaker and
 * no retry — a health probe must be cheap, single-shot and fail-soft. It is the
 * canonical reusable client behind the assistant's `.dependencies.modelConnector`
 * and `.dependencies.authArcana` entries, both of which probe a public HTTPS
 * surface that requires no `Authorization` header (verified live, 2026-06-03).
 * An optional `bearerToken` is supported for upstreams that gate `/health`.
 */
export interface HttpHealthClientOptions {
  /** Base URL — the probe hits `{baseUrl}/health`. Trailing slashes trimmed. */
  baseUrl: string;
  /** Optional health path override (default `/health`). */
  healthPath?: string;
  /** Optional bearer token; omitted entirely when unset (no empty header). */
  bearerToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface IHttpHealthClient {
  ping(): Promise<PingResult>;
}

export class HttpHealthClient implements IHttpHealthClient {
  private readonly url: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpHealthClientOptions) {
    const base = opts.baseUrl.replace(/\/+$/, '');
    const path = opts.healthPath ?? '/health';
    this.url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    this.bearerToken = opts.bearerToken;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 2_000;
  }

  async ping(): Promise<PingResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (this.bearerToken) headers['Authorization'] = `Bearer ${this.bearerToken}`;
      const res = await this.fetchImpl(this.url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      const contentType = res.headers.get('content-type') ?? '';
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, latencyMs, error: `HTTP ${res.status}` };
      }
      const json = contentType.includes('application/json') && text ? JSON.parse(text) : undefined;
      const parsed = HealthResponseSchema.safeParse(json);
      // 2xx with a parseable body → trust the `status` field; 2xx without a
      // JSON body still counts as live (some health endpoints return text).
      const ok = parsed.success ? parsed.data.status === 'ok' : true;
      return {
        ok,
        latencyMs,
        ...(parsed.success && parsed.data.version ? { version: parsed.data.version } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
