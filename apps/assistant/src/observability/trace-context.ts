import { randomBytes } from 'node:crypto';

/**
 * ARCA-0009 M8 D3 — minimal W3C-traceparent surface (V-AC-9).
 *
 * Real OTel SDK bootstrap (`@opentelemetry/sdk-node` + OTLP exporter) is
 * deferred to a follow-up backlog row to avoid heavy install + Docker
 * rebuild during the hardening sprint. This module ships the *contract*
 * — `TraceContext` API + pino bridge — so all call sites (orchestrator,
 * outbound clients, controllers) wire against the interface today and
 * gain real spans the moment a `NodeSDK`-backed implementation lands.
 *
 * The default `NoopTraceContext` returns deterministic ids so logs stay
 * useful for correlating a single request even before SDK bootstrap.
 */

export interface TraceSpan {
  /** 32-hex-char W3C trace-id. */
  readonly traceId: string;
  /** 16-hex-char span-id. */
  readonly spanId: string;
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: 'ok' | 'error', message?: string): void;
  end(): void;
}

export interface TraceContext {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): TraceSpan;
  currentSpan(): TraceSpan | undefined;
  /**
   * Returns the trace context to attach to outbound HTTP calls per W3C
   * traceparent (`00-<trace-id>-<span-id>-01`) when a span is active.
   */
  outboundHeaders(): Record<string, string>;
}

const ACTIVE_SPAN = Symbol('active-span');

interface SpanFrame {
  span: SimpleSpan;
  parentTraceId: string;
}

class SimpleSpan implements TraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  private attributes: Record<string, string | number | boolean> = {};
  private status: 'ok' | 'error' | 'unset' = 'unset';
  private ended = false;
  constructor(
    traceId: string,
    spanId: string,
    private readonly onEnd: (span: SimpleSpan) => void,
  ) {
    this.traceId = traceId;
    this.spanId = spanId;
  }
  setAttribute(key: string, value: string | number | boolean): void {
    if (this.ended) return;
    this.attributes[key] = value;
  }
  setStatus(status: 'ok' | 'error', message?: string): void {
    if (this.ended) return;
    this.status = status;
    if (message) this.attributes['status.message'] = message;
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd(this);
  }
  isEnded(): boolean {
    return this.ended;
  }
  getStatus(): 'ok' | 'error' | 'unset' {
    return this.status;
  }
  getAttributes(): Readonly<Record<string, string | number | boolean>> {
    return { ...this.attributes };
  }
}

/**
 * AsyncLocalStorage-free in-process trace context. Sufficient for unit tests
 * and synchronous request flows. The real SDK swap will replace this with
 * AsyncLocalStorage-backed propagation across `await` boundaries.
 */
export class NoopTraceContext implements TraceContext {
  private stack: SpanFrame[] = [];
  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): TraceSpan {
    const parent = this.stack[this.stack.length - 1];
    const traceId = parent?.span.traceId ?? hex(16);
    const spanId = hex(8);
    const frame: SpanFrame = {
      span: new SimpleSpan(traceId, spanId, (s) => {
        const idx = this.stack.findIndex((f) => f.span === s);
        if (idx !== -1) this.stack.splice(idx, 1);
      }),
      parentTraceId: parent?.span.traceId ?? traceId,
    };
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) frame.span.setAttribute(k, v);
    }
    frame.span.setAttribute('span.name', name);
    this.stack.push(frame);
    return frame.span;
  }
  currentSpan(): TraceSpan | undefined {
    return this.stack[this.stack.length - 1]?.span;
  }
  outboundHeaders(): Record<string, string> {
    const span = this.currentSpan();
    if (!span) return {};
    return { traceparent: `00-${span.traceId}-${span.spanId}-01` };
  }
}

export const TRACE_CONTEXT = Symbol.for('TRACE_CONTEXT');
export const ACTIVE_SPAN_KEY = ACTIVE_SPAN;

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
