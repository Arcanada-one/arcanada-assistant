import { describe, expect, it, vi } from 'vitest';

import { ProactiveProcessor } from './proactive.processor.js';
import type { BriefingAggregator } from './briefing.aggregator.js';
import type { DigestAggregator } from './digest.aggregator.js';
import type { ProactiveDispatcherService } from './proactive-dispatcher.service.js';
import type { ProactiveConfigService } from './proactive-config.service.js';
import type { ProactiveConfig } from './proactive.types.js';

function configSnapshot(over: Partial<ProactiveConfig> = {}): ProactiveConfig {
  return {
    enabled: true,
    timezone: 'Europe/Istanbul',
    channels: {
      briefing: {
        enabled: true,
        cron: '0 8 * * *',
        chat_id: 100,
        include_active_tasks: true,
        include_backlog_top_n: 3,
        include_ecosystem_snapshot: true,
        include_night_events_section: false,
      },
      digest: {
        enabled: true,
        cron: '0 21 * * *',
        chat_id: 100,
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
    observability: { pino_level: 'info', prometheus_counter: 'x' },
    ...over,
  };
}

function buildProcessor(config: ProactiveConfig | null): {
  proc: ProactiveProcessor;
  briefing: { compose: ReturnType<typeof vi.fn> };
  digest: { compose: ReturnType<typeof vi.fn> };
  dispatcher: { dispatch: ReturnType<typeof vi.fn> };
} {
  const briefing = { compose: vi.fn().mockResolvedValue({ text: 'B', sections: [] }) };
  const digest = { compose: vi.fn().mockResolvedValue({ text: 'D', sections: [] }) };
  const dispatcher = { dispatch: vi.fn().mockResolvedValue({ status: 'sent', messageId: 1 }) };
  const cfg = { snapshot: () => config } as unknown as ProactiveConfigService;
  const proc = new ProactiveProcessor(
    briefing as unknown as BriefingAggregator,
    digest as unknown as DigestAggregator,
    dispatcher as unknown as ProactiveDispatcherService,
    cfg,
  );
  return { proc, briefing, digest, dispatcher };
}

describe('ProactiveProcessor', () => {
  it('returns skipped when config not loaded', async () => {
    const { proc } = buildProcessor(null);
    const res = await proc.process({ kind: 'briefing' });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('config-not-loaded');
  });

  it('returns skipped when global kill switch is off', async () => {
    const { proc, dispatcher } = buildProcessor(configSnapshot({ enabled: false }));
    const res = await proc.process({ kind: 'briefing' });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('globally-disabled');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('returns skipped when channel is disabled', async () => {
    const cfg = configSnapshot();
    cfg.channels.briefing.enabled = false;
    const { proc, dispatcher } = buildProcessor(cfg);
    const res = await proc.process({ kind: 'briefing' });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('channel-disabled');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('routes briefing kind through BriefingAggregator', async () => {
    const { proc, briefing, digest, dispatcher } = buildProcessor(configSnapshot());
    await proc.process({ kind: 'briefing', runDate: '2026-05-18' });
    expect(briefing.compose).toHaveBeenCalledTimes(1);
    expect(digest.compose).not.toHaveBeenCalled();
    const dispatchArgs = dispatcher.dispatch.mock.calls[0]![0] as { kind: string; chatId: number };
    expect(dispatchArgs.kind).toBe('briefing');
    expect(dispatchArgs.chatId).toBe(100);
  });

  it('routes digest kind through DigestAggregator', async () => {
    const { proc, briefing, digest } = buildProcessor(configSnapshot());
    await proc.process({ kind: 'digest', runDate: '2026-05-18' });
    expect(digest.compose).toHaveBeenCalledTimes(1);
    expect(briefing.compose).not.toHaveBeenCalled();
  });

  it('derives runDate from Europe/Istanbul timezone when not provided', async () => {
    const { proc, briefing } = buildProcessor(configSnapshot());
    await proc.process({ kind: 'briefing' });
    const args = briefing.compose.mock.calls[0]![0] as { runDate: string };
    expect(args.runDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
