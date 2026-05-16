import {
  DreamerResultSchema,
  IndexPageOkSchema,
  IndexPageRequestSchema,
  LinkGraphOkSchema,
  LinkGraphRequestSchema,
  SummarizeOkSchema,
  SummarizeRequestSchema,
  type DreamerResult,
  type IndexPageRequest,
  type LinkGraphRequest,
  type SummarizeRequest,
} from './dreamer.schemas.js';

export interface DreamerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug?(obj: Record<string, unknown>, msg?: string): void;
}

export interface DreamerClientOptions {
  baseUrl?: string;
  apiToken?: string;
  timeoutMs?: number;
  /**
   * When `false` (default), client returns `unavailable: dreamer_not_migrated`
   * for every call without touching the network. When `true` (post AGENT-*
   * server migration + ARCA-* Phase 6b wire-up), live HTTP path will be
   * implemented in the follow-up task. Until then, even with `live=true` the
   * client throws to signal that the migration path is still gated.
   */
  live?: boolean;
  fetchImpl?: typeof fetch;
  logger?: DreamerLogger;
}

export interface IDreamerClient {
  indexPage(req: IndexPageRequest): Promise<DreamerResult>;
  summarize(req: SummarizeRequest): Promise<DreamerResult>;
  linkGraph(req: LinkGraphRequest): Promise<DreamerResult>;
  isLive(): boolean;
}

export class DreamerClientError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DreamerClientError';
    this.cause = cause;
  }
}

/**
 * Skeleton client for the Dreamer mesh agent. The live HTTP path is gated by
 * Operational Resilience Mandate Principle 2 (the Dreamer service must run on
 * an Arcanada server, not a workstation cron). Until the dedicated AGENT-*
 * migration task lands, this client refuses to issue network calls and
 * returns a structured `unavailable` envelope instead. The interface and Zod
 * schemas are stable so callers can integrate now and switch on the live
 * path with a config flip once AGENT-* + ARCA-* Phase 6b ship.
 */
export class DreamerClient implements IDreamerClient {
  private readonly live: boolean;
  private readonly logger?: DreamerLogger;

  constructor(opts: DreamerClientOptions = {}) {
    this.live = opts.live ?? false;
    this.logger = opts.logger;
    if (this.live) {
      // Future: validate baseUrl + apiToken + fetchImpl + timeoutMs and bind a
      // CircuitBreaker. M6 ships skeleton-only per Q&A round 3.
      this.logger?.warn(
        { component: 'dreamer-client' },
        'DREAMER_LIVE=true requested but live HTTP path is unimplemented (M6 skeleton); falling back to unavailable envelope',
      );
    }
  }

  isLive(): boolean {
    return false;
  }

  async indexPage(req: IndexPageRequest): Promise<DreamerResult> {
    return this.skeletonCall(IndexPageRequestSchema, req, 'indexPage');
  }

  async summarize(req: SummarizeRequest): Promise<DreamerResult> {
    return this.skeletonCall(SummarizeRequestSchema, req, 'summarize');
  }

  async linkGraph(req: LinkGraphRequest): Promise<DreamerResult> {
    return this.skeletonCall(LinkGraphRequestSchema, req, 'linkGraph');
  }

  private async skeletonCall<T extends { safeParse: (req: unknown) => { success: boolean } }>(
    schema: T,
    req: unknown,
    op: string,
  ): Promise<DreamerResult> {
    const parsed = schema.safeParse(req);
    if (!parsed.success) {
      throw new DreamerClientError(`Invalid Dreamer ${op} request`, parsed);
    }
    this.logger?.debug?.(
      { component: 'dreamer-client', op },
      'dreamer skeleton call refused — awaiting AGENT-* migration',
    );
    return DreamerResultSchema.parse({
      kind: 'unavailable',
      reason: 'dreamer_not_migrated',
      detail:
        'Dreamer mesh wiring deferred to ARCA-* Phase 6b after AGENT-* Dreamer server migration (Operational Resilience Mandate Principle 2).',
    });
  }
}

/**
 * Type guards re-exported from schemas to ease future migration of consumer
 * tests when the live HTTP path lands.
 */
export const _internalOkSchemas = {
  IndexPageOkSchema,
  SummarizeOkSchema,
  LinkGraphOkSchema,
};
