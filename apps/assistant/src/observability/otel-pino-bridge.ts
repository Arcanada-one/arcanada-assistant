import type { TraceContext } from './trace-context.js';

/**
 * Returns a pino `mixin` function that injects W3C trace-id / span-id into
 * every log record when a span is active. The mixin is pure-by-context: if
 * no span is on the stack, the fields are omitted (no `undefined` noise).
 *
 *   logger = pino({ mixin: pinoTraceMixin(traceContext) })
 *
 * Downstream consumers (Loki / Tempo / Grafana) can correlate via `trace_id`
 * once the real OTel SDK pumps spans into an exporter.
 */
export function pinoTraceMixin(
  traceContext: TraceContext,
): () => Record<string, unknown> {
  return () => {
    const span = traceContext.currentSpan();
    if (!span) return {};
    return { trace_id: span.traceId, span_id: span.spanId };
  };
}
