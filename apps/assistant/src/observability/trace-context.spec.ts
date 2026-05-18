import { describe, expect, it } from 'vitest';

import { NoopTraceContext } from './trace-context.js';
import { pinoTraceMixin } from './otel-pino-bridge.js';

describe('NoopTraceContext', () => {
  it('issues 32-hex trace-id and 16-hex span-id for a new root span', () => {
    const ctx = new NoopTraceContext();
    const span = ctx.startSpan('orchestrator.route');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('child span inherits trace-id and has a new span-id', () => {
    const ctx = new NoopTraceContext();
    const parent = ctx.startSpan('orchestrator.route');
    const child = ctx.startSpan('munera.client.createTask');
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
  });

  it('currentSpan returns innermost active span', () => {
    const ctx = new NoopTraceContext();
    const parent = ctx.startSpan('a');
    const child = ctx.startSpan('b');
    expect(ctx.currentSpan()).toBe(child);
    child.end();
    expect(ctx.currentSpan()).toBe(parent);
    parent.end();
    expect(ctx.currentSpan()).toBeUndefined();
  });

  it('outboundHeaders formats W3C traceparent only when a span is active', () => {
    const ctx = new NoopTraceContext();
    expect(ctx.outboundHeaders()).toEqual({});
    const span = ctx.startSpan('outbound');
    const headers = ctx.outboundHeaders();
    expect(headers.traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
    span.end();
    expect(ctx.outboundHeaders()).toEqual({});
  });

  it('setStatus is idempotent after end()', () => {
    const ctx = new NoopTraceContext();
    const span = ctx.startSpan('x');
    span.end();
    expect(() => span.setStatus('error', 'too late')).not.toThrow();
  });

  it('span.setAttribute is a no-op after end()', () => {
    const ctx = new NoopTraceContext();
    const span = ctx.startSpan('x');
    span.setAttribute('agent', 'transcriber');
    span.end();
    expect(() => span.setAttribute('after', 'ignored')).not.toThrow();
  });
});

describe('pinoTraceMixin', () => {
  it('returns {} when no span is active', () => {
    const ctx = new NoopTraceContext();
    const mixin = pinoTraceMixin(ctx);
    expect(mixin()).toEqual({});
  });

  it('injects trace_id + span_id when a span is on the stack', () => {
    const ctx = new NoopTraceContext();
    const span = ctx.startSpan('orchestrator.route');
    const mixin = pinoTraceMixin(ctx);
    expect(mixin()).toEqual({ trace_id: span.traceId, span_id: span.spanId });
  });
});
