/**
 * AAL L3 — Exception hierarchy (V-AC-11).
 *
 * Every mesh-agent fault that surfaces past the orchestrator boundary is one
 * of five named subclasses of `AgentError`. The classifier turns an arbitrary
 * unknown thrown by an agent / client into a typed failure with a stable
 * `kind` discriminator suitable for pino logs, Ops Bot routing, and unit
 * assertions.
 *
 * Per-client HTTP error classes (e.g. `TranscriberClientError`) live in their
 * own modules; they are *causes*, not the surface. The orchestrator + scope
 * guard + auth middleware throw `AgentError` subclasses, never bare `Error`.
 */

export type AgentErrorKind =
  | 'auth'
  | 'timeout'
  | 'soft_fail'
  | 'validation'
  | 'scope';

export interface AgentErrorOptions {
  agent?: string;
  intent?: string;
  cause?: unknown;
  detail?: string;
}

export abstract class AgentError extends Error {
  abstract readonly kind: AgentErrorKind;
  readonly agent?: string;
  readonly intent?: string;
  readonly cause?: unknown;
  readonly detail?: string;

  constructor(message: string, opts?: AgentErrorOptions) {
    super(message);
    this.name = new.target.name;
    if (opts?.agent !== undefined) this.agent = opts.agent;
    if (opts?.intent !== undefined) this.intent = opts.intent;
    if (opts?.cause !== undefined) this.cause = opts.cause;
    if (opts?.detail !== undefined) this.detail = opts.detail;
  }
}

export class AgentAuthError extends AgentError {
  readonly kind = 'auth' as const;
}

export class AgentTimeoutError extends AgentError {
  readonly kind = 'timeout' as const;
  readonly timeoutMs?: number;
  constructor(message: string, opts?: AgentErrorOptions & { timeoutMs?: number }) {
    super(message, opts);
    if (opts?.timeoutMs !== undefined) this.timeoutMs = opts.timeoutMs;
  }
}

export class AgentSoftFailError extends AgentError {
  readonly kind = 'soft_fail' as const;
  readonly reason?: string;
  constructor(message: string, opts?: AgentErrorOptions & { reason?: string }) {
    super(message, opts);
    if (opts?.reason !== undefined) this.reason = opts.reason;
  }
}

export class AgentValidationError extends AgentError {
  readonly kind = 'validation' as const;
  readonly issues?: ReadonlyArray<{ path: string; message: string }>;
  constructor(
    message: string,
    opts?: AgentErrorOptions & { issues?: ReadonlyArray<{ path: string; message: string }> },
  ) {
    super(message, opts);
    if (opts?.issues !== undefined) this.issues = opts.issues;
  }
}

export class AgentScopeError extends AgentError {
  readonly kind = 'scope' as const;
  readonly principal?: string;
  constructor(message: string, opts?: AgentErrorOptions & { principal?: string }) {
    super(message, opts);
    if (opts?.principal !== undefined) this.principal = opts.principal;
  }
}

/**
 * Classify any thrown value into a known `AgentError`. Unknown errors return
 * `undefined` so callers can decide whether to wrap (`AgentSoftFailError`) or
 * rethrow.
 */
export function classifyAgentError(err: unknown): AgentError | undefined {
  if (err instanceof AgentError) return err;
  return undefined;
}

export function isAgentError(err: unknown): err is AgentError {
  return err instanceof AgentError;
}
