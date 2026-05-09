import { describe, it, expect } from 'vitest';

import {
  EmitEventResponseSchema,
  EcosystemSnapshotSchema,
  type EcosystemSnapshot,
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
