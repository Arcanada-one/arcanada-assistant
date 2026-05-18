import CircuitBreaker from 'opossum';

import {
  SttErrorEnvelopeSchema,
  SttSuccessSchema,
  SttUnauthorizedEnvelopeSchema,
  TranscribeRequestSchema,
  TranscribeResultSchema,
  type TranscribeRequest,
  type TranscribeResult,
} from './transcriber.schemas.js';

export interface TranscriberLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug?(obj: Record<string, unknown>, msg?: string): void;
}

export interface TranscriberRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}

export interface TranscriberCircuitOptions {
  volumeThreshold: number;
  errorThresholdPercentage: number;
  rollingCountTimeout: number;
  resetTimeout: number;
}

export interface TranscriberClientOptions {
  /**
   * Model Connector base URL — e.g. `http://localhost:3900` on PROD (Assistant
   * co-located with MC) or `https://connector.arcanada.one` via nginx.
   */
  baseUrl: string;
  /** Bearer API key issued by MC `/admin/keys` and stored in Vault. */
  apiKey: string;
  logger?: TranscriberLogger;
  fetchImpl?: typeof fetch;
  /** Total per-request timeout. STT P95 is ~300 ms for 1 s audio; defaults to 30 s for long voice messages. */
  timeoutMs?: number;
  retry?: TranscriberRetryOptions;
  circuit?: TranscriberCircuitOptions;
  /** Optional override of default STT model (MC chooses from cascade per CONN-0103). */
  defaultModel?: string;
  serviceName?: string;
}

export interface ITranscriberClient {
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
  isCircuitOpen(): boolean;
}

export class TranscriberClientError extends Error {
  readonly cause?: unknown;
  readonly httpStatus?: number;
  readonly errorCode?: string;
  constructor(
    message: string,
    opts?: { cause?: unknown; httpStatus?: number; errorCode?: string },
  ) {
    super(message);
    this.name = 'TranscriberClientError';
    this.cause = opts?.cause;
    this.httpStatus = opts?.httpStatus;
    this.errorCode = opts?.errorCode;
  }
}

interface HttpResult {
  status: number;
  body: unknown;
}

const DEFAULT_CIRCUIT: TranscriberCircuitOptions = {
  volumeThreshold: 5,
  errorThresholdPercentage: 99,
  rollingCountTimeout: 30_000,
  resetTimeout: 60_000,
};

const DEFAULT_RETRY: TranscriberRetryOptions = { maxAttempts: 2, baseDelayMs: 250 };

const STT_PATH = '/v1/speech/stt';

export class TranscriberClient implements ITranscriberClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retry: TranscriberRetryOptions;
  private readonly defaultModel?: string;
  private readonly breaker: CircuitBreaker<[TranscribeRequest], TranscribeResult>;

  constructor(opts: TranscriberClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.defaultModel = opts.defaultModel;
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

  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    const parsed = TranscribeRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw new TranscriberClientError(`Invalid transcribe request: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }
    try {
      return await this.breaker.fire(parsed.data);
    } catch (err) {
      if (this.breaker.opened) {
        const msg = err instanceof Error ? err.message : String(err);
        return TranscribeResultSchema.parse({
          kind: 'unavailable',
          reason: 'transcriber_circuit_open',
          detail: msg,
        });
      }
      if (err instanceof TranscriberClientError && isClientFault(err)) {
        return TranscribeResultSchema.parse({
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

  private async executeWithRetry(req: TranscribeRequest): Promise<TranscribeResult> {
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
    throw lastErr instanceof Error ? lastErr : new TranscriberClientError(String(lastErr));
  }

  private async callOnce(req: TranscribeRequest): Promise<TranscribeResult> {
    const url = `${this.baseUrl}${STT_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      const blob = new Blob([new Uint8Array(req.audio)], { type: req.mimeType });
      form.append('file', blob, req.filename ?? 'audio.bin');
      if (req.language) form.append('language', req.language);
      const effectiveModel = req.model ?? this.defaultModel;
      if (effectiveModel) form.append('model', effectiveModel);
      if (req.prompt) form.append('prompt', req.prompt);
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiKey}`,
      };
      if (req.requestId) headers['x-request-id'] = req.requestId;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
      const result = await readJson(res);
      return this.mapResponse(result);
    } finally {
      clearTimeout(timer);
    }
  }

  private mapResponse(result: HttpResult): TranscribeResult {
    if (result.status >= 200 && result.status < 300) {
      const parsed = SttSuccessSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new TranscriberClientError(`Invalid STT success envelope: ${parsed.error.message}`, {
          cause: parsed.error,
          httpStatus: result.status,
        });
      }
      const env = parsed.data;
      return TranscribeResultSchema.parse({
        kind: 'ok',
        transcription: env.transcription,
        provider: env.provider,
        model: env.model,
        language: env.language,
        latencyMs: env.latency_ms,
        costUsd: env.cost_usd,
        audioDurationSeconds: env.audio_duration_seconds,
        requestId: env.request_id,
        fallbackCount: env.fallback_count,
      });
    }
    const sttErr = SttErrorEnvelopeSchema.safeParse(result.body);
    if (sttErr.success) {
      throw new TranscriberClientError(sttErr.data.message, {
        httpStatus: result.status,
        errorCode: sttErr.data.error_code,
      });
    }
    const unauthorized = SttUnauthorizedEnvelopeSchema.safeParse(result.body);
    if (unauthorized.success) {
      throw new TranscriberClientError(unauthorized.data.message, {
        httpStatus: result.status,
        errorCode: 'unauthorized',
      });
    }
    throw new TranscriberClientError(`HTTP ${result.status}: ${truncate(result.body)}`, {
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
  if (!(err instanceof TranscriberClientError)) return false;
  const s = err.httpStatus;
  if (s === undefined) return false;
  return s >= 400 && s < 500 && s !== 408 && s !== 429;
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof TranscriberClientError)) return true;
  const s = err.httpStatus;
  if (s === undefined) return true;
  return s >= 500 || s === 408 || s === 429;
}

function classifyReason(err: TranscriberClientError): string {
  if (err.errorCode === 'unauthorized') return 'transcriber_unauthorized';
  if (err.errorCode === 'stt_unsupported_mime') return 'transcriber_unsupported_mime';
  if (err.errorCode === 'stt_validation_error') return 'transcriber_validation_error';
  if (err.errorCode === 'stt_audio_too_large') return 'transcriber_audio_too_large';
  if (err.errorCode === 'stt_budget_exhausted') return 'transcriber_budget_exhausted';
  if (err.errorCode === 'stt_all_providers_exhausted') return 'transcriber_providers_exhausted';
  return `transcriber_${err.errorCode ?? 'client_error'}`;
}
