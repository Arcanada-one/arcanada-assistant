import { describe, it, expect } from 'vitest';

import {
  EmitEventResponseSchema,
  EcosystemSnapshotSchema,
  OpsBotWireEventSchema,
  toOpsBotWireEvent,
  type EcosystemSnapshot,
  type EmitEventInput,
} from './ops-bot.types.js';

describe('EmitEventResponseSchema', () => {
  it('accepts a valid Ops Bot ack', () => {
    const result = EmitEventResponseSchema.safeParse({
      event_id: '01J2H7K8FXYJ9P0Q3R5T6V8W0Z',
      status: 'accepted',
    });
    expect(result.success).toBe(true);
  });

  it('accepts ack with optional received_at', () => {
    const result = EmitEventResponseSchema.safeParse({
      event_id: '01J2H7K8FXYJ9P0Q3R5T6V8W0Z',
      status: 'accepted',
      received_at: '2026-05-09T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects response missing event_id', () => {
    const result = EmitEventResponseSchema.safeParse({ status: 'accepted' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown status value', () => {
    const result = EmitEventResponseSchema.safeParse({
      event_id: 'x',
      status: 'something-weird',
    });
    expect(result.success).toBe(false);
  });
});

describe('EcosystemSnapshotSchema', () => {
  it('accepts a parsed snapshot with all counters', () => {
    const snapshot: EcosystemSnapshot = {
      agents_total: 5,
      events_total: 42,
      approvals_pending: 1,
      parsed_at: '2026-05-09T12:00:00.000Z',
    };
    const result = EcosystemSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
  });

  it('rejects snapshot with negative counters', () => {
    const result = EcosystemSnapshotSchema.safeParse({
      agents_total: -1,
      events_total: 0,
      approvals_pending: 0,
      parsed_at: '2026-05-09T12:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects snapshot without parsed_at', () => {
    const result = EcosystemSnapshotSchema.safeParse({
      agents_total: 0,
      events_total: 0,
      approvals_pending: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ARCA-0122: OpsBotEventSchema (assistant's internal shape) vs opsbot's
// actual CreateEventDto wire shape drifted since ARCA-0007 — mocked tests
// hid it because they never asserted the outbound request body. These tests
// pin the translation boundary (toOpsBotWireEvent) and its output schema
// (a hand-maintained mirror of opsbot's CreateEventDto).
describe('toOpsBotWireEvent (ARCA-0122)', () => {
  const base: EmitEventInput = {
    service: 'arcanada-assistant',
    category: 'fatal',
    severity: 'fatal',
    message: 'ouch',
  };

  it('maps service -> agent and passes category/message through for a direct match', () => {
    const wire = toOpsBotWireEvent(base);
    expect(wire).toEqual({
      category: 'fatal',
      agent: 'arcanada-assistant',
      title: 'ouch',
      body: '',
    });
    expect(OpsBotWireEventSchema.safeParse(wire).success).toBe(true);
  });

  it.each([
    ['warning', 'warning'],
    ['tool_failure', 'warning'],
    ['cost_breaker_trip', 'warning'],
    ['self_heal', 'info'],
    ['briefing_cycle', 'digest'],
    ['audit', 'info'],
  ] as const)(
    'maps assistant category %s -> opsbot category %s',
    (assistantCategory, wireCategory) => {
      const wire = toOpsBotWireEvent({ ...base, category: assistantCategory });
      expect(wire.category).toBe(wireCategory);
    },
  );

  it('serializes context into body as JSON', () => {
    const wire = toOpsBotWireEvent({
      ...base,
      context: { component: 'proactive-dispatcher', consecutive_failures: 3 },
    });
    expect(wire.body).toBe(
      JSON.stringify({ component: 'proactive-dispatcher', consecutive_failures: 3 }),
    );
  });

  it('carries audit_ref through as dedup_key', () => {
    const wire = toOpsBotWireEvent({ ...base, audit_ref: 'cmd-01J2H7K8FXY' });
    expect(wire.dedup_key).toBe('cmd-01J2H7K8FXY');
  });

  it('omits dedup_key when audit_ref is absent', () => {
    const wire = toOpsBotWireEvent(base);
    expect(wire).not.toHaveProperty('dedup_key');
  });

  it('truncates a message beyond opsbot title max (256) rather than failing', () => {
    const longMessage = 'x'.repeat(300);
    const wire = toOpsBotWireEvent({ ...base, message: longMessage });
    expect(wire.title.length).toBe(256);
    expect(OpsBotWireEventSchema.safeParse(wire).success).toBe(true);
  });

  it('truncates an oversized context payload beyond opsbot body max (4000)', () => {
    const wire = toOpsBotWireEvent({
      ...base,
      context: { blob: 'y'.repeat(5000) },
    });
    expect(wire.body.length).toBe(4000);
    expect(OpsBotWireEventSchema.safeParse(wire).success).toBe(true);
  });

  it('produces a payload that always validates against the real opsbot CreateEventDto mirror', () => {
    for (const category of [
      'fatal',
      'self_heal',
      'cost_breaker_trip',
      'briefing_cycle',
      'tool_failure',
      'warning',
      'audit',
    ] as const) {
      const wire = toOpsBotWireEvent({ ...base, category });
      expect(OpsBotWireEventSchema.safeParse(wire).success).toBe(true);
    }
  });
});
