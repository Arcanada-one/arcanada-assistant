import { NoopTraceContext, type TraceContext } from './trace-context.js';

/**
 * Process-wide singleton used by pino mixin AND the DI factory so spans
 * started inside `OrchestratorService` are visible in log records emitted
 * from anywhere in the request lifecycle. The real OTel SDK swap will
 * replace this with an AsyncLocalStorage-backed propagator.
 */
const singleton: TraceContext = new NoopTraceContext();

export function defaultTraceContext(): TraceContext {
  return singleton;
}
