import { describe, it, expect } from 'vitest';

import { OpsBotEventSchema, TelegramUpdateStubSchema, OpsBotEventCategory } from './schemas.js';

describe('OpsBotEventSchema', () => {
  it('accepts a valid fatal event', () => {
    const result = OpsBotEventSchema.safeParse({
      service: 'arcanada-assistant',
      category: 'fatal',
      severity: 'fatal',
      message: 'PG connection lost',
      context: { db: 'arcana-db' },
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts self_heal event without context', () => {
    const result = OpsBotEventSchema.safeParse({
      service: 'arcanada-assistant',
      category: 'self_heal',
      severity: 'info',
      message: 'circuit breaker closed (model-connector)',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown category', () => {
    const result = OpsBotEventSchema.safeParse({
      service: 'x',
      category: 'made_up',
      severity: 'info',
      message: 'm',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = OpsBotEventSchema.safeParse({
      service: 'x',
      category: 'fatal',
      // severity, message, timestamp missing
    });
    expect(result.success).toBe(false);
  });

  it('exposes the canonical category enum', () => {
    expect(OpsBotEventCategory).toContain('fatal');
    expect(OpsBotEventCategory).toContain('self_heal');
    expect(OpsBotEventCategory).toContain('cost_breaker_trip');
    expect(OpsBotEventCategory).toContain('briefing_cycle');
    expect(OpsBotEventCategory).toContain('tool_failure');
  });
});

describe('TelegramUpdateStubSchema', () => {
  it('accepts a typical text-message update', () => {
    const result = TelegramUpdateStubSchema.safeParse({
      update_id: 12345,
      message: {
        message_id: 1,
        date: 1714000000,
        chat: { id: 999, type: 'private' },
        from: { id: 999, is_bot: false, first_name: 'Pavel' },
        text: '/start',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects update without update_id', () => {
    const result = TelegramUpdateStubSchema.safeParse({ message: { text: 'hi' } });
    expect(result.success).toBe(false);
  });
});
