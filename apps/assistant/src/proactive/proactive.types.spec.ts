import { describe, expect, it } from 'vitest';

import { ProactiveConfigSchema } from './proactive.types.js';

describe('ProactiveConfigSchema', () => {
  const validConfig = {
    enabled: false,
    timezone: 'Europe/Istanbul' as const,
    channels: {
      briefing: {
        enabled: true,
        cron: '0 8 * * *',
        chat_id: 1234567890,
        include_active_tasks: true,
        include_backlog_top_n: 3,
        include_ecosystem_snapshot: true,
        include_night_events_section: false,
      },
      digest: {
        enabled: true,
        cron: '0 21 * * *',
        chat_id: 1234567890,
        include_completed_tasks: true,
        include_archived_items: true,
        include_key_events: false,
      },
    },
    dispatch: {
      max_attempts: 3,
      base_backoff_ms: 1000,
      self_heal_threshold: 3,
      fallback_to_plain_text_on_md_error: true,
    },
    observability: {
      pino_level: 'info' as const,
      prometheus_counter: 'assistant_proactive_dispatched_total',
    },
  };

  it('parses a valid fixture config', () => {
    const result = ProactiveConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it('rejects timezone other than Europe/Istanbul', () => {
    const bad = { ...validConfig, timezone: 'UTC' };
    expect(ProactiveConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects max_attempts above 10', () => {
    const bad = { ...validConfig, dispatch: { ...validConfig.dispatch, max_attempts: 11 } };
    expect(ProactiveConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects include_backlog_top_n above 10', () => {
    const bad = {
      ...validConfig,
      channels: {
        ...validConfig.channels,
        briefing: { ...validConfig.channels.briefing, include_backlog_top_n: 99 },
      },
    };
    expect(ProactiveConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts string chat_id (for legacy private chats)', () => {
    const sConfig = {
      ...validConfig,
      channels: {
        ...validConfig.channels,
        briefing: { ...validConfig.channels.briefing, chat_id: '@my_private_chat' },
      },
    };
    expect(ProactiveConfigSchema.safeParse(sConfig).success).toBe(true);
  });

  it('defaults enabled to false when omitted', () => {
    const { enabled: _omit, ...rest } = validConfig;
    void _omit;
    const result = ProactiveConfigSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.enabled).toBe(false);
  });
});
