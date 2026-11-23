import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { ConfigService } from '@nestjs/config';

import { ProactiveModule } from './proactive.module.js';
import type { ProactiveConfigService } from './proactive-config.service.js';
import type { ProactiveProcessor } from './proactive.processor.js';
import type { ProactiveConfig } from './proactive.types.js';

function config(overrides: Partial<ProactiveConfig> = {}): ProactiveConfig {
  return {
    enabled: true,
    timezone: 'Europe/Istanbul',
    channels: {
      briefing: {
        enabled: true,
        cron: '0 8 * * *',
        chat_id: 10,
        include_active_tasks: true,
        include_backlog_top_n: 3,
        include_ecosystem_snapshot: true,
        include_night_events_section: false,
      },
      digest: {
        enabled: true,
        cron: '0 21 * * *',
        chat_id: 10,
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
    observability: { pino_level: 'info', prometheus_counter: 'test' },
    ...overrides,
  };
}

function harness(schedulers: Array<{ id?: string | null }> = []) {
  const queue = {
    upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
    getJobSchedulers: vi.fn().mockResolvedValue(schedulers),
    removeJobScheduler: vi.fn().mockResolvedValue(true),
  };
  const module = new ProactiveModule(
    {} as ConfigService,
    {} as ProactiveConfigService,
    {} as ProactiveProcessor,
    queue as unknown as Queue,
  );
  const internals = module as unknown as {
    reconcile(next: ProactiveConfig, previous: ProactiveConfig | null): Promise<void>;
  };
  return { queue, reconcile: internals.reconcile.bind(module) };
}

describe('ProactiveModule BullMQ 6 job scheduler integration', () => {
  it('upserts stable schedulers with each configured cron and timezone', async () => {
    const { queue, reconcile } = harness();

    await reconcile(config(), null);

    expect(queue.upsertJobScheduler).toHaveBeenNthCalledWith(
      1,
      'proactive:briefing:daily',
      { pattern: '0 8 * * *', tz: 'Europe/Istanbul' },
      { name: 'briefing', data: { kind: 'briefing' } },
    );
    expect(queue.upsertJobScheduler).toHaveBeenNthCalledWith(
      2,
      'proactive:digest:daily',
      { pattern: '0 21 * * *', tz: 'Europe/Istanbul' },
      { name: 'digest', data: { kind: 'digest' } },
    );
  });

  it('updates a changed schedule through the same scheduler id', async () => {
    const { queue, reconcile } = harness();
    await reconcile(config(), null);
    queue.upsertJobScheduler.mockClear();

    await reconcile(
      config({
        channels: {
          ...config().channels,
          briefing: { ...config().channels.briefing, cron: '0 9 * * *' },
        },
      }),
      config(),
    );

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'proactive:briefing:daily',
      { pattern: '0 9 * * *', tz: 'Europe/Istanbul' },
      { name: 'briefing', data: { kind: 'briefing' } },
    );
  });

  it('removes disabled schedulers by their stable ids', async () => {
    const { queue, reconcile } = harness();
    await reconcile(
      config({
        channels: {
          ...config().channels,
          briefing: { ...config().channels.briefing, enabled: false },
        },
      }),
      null,
    );

    expect(queue.removeJobScheduler).toHaveBeenCalledWith('proactive:briefing:daily');
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'proactive:digest:daily',
      { pattern: '0 21 * * *', tz: 'Europe/Istanbul' },
      { name: 'digest', data: { kind: 'digest' } },
    );
  });

  it('clears existing schedulers when the proactive module is disabled', async () => {
    const { queue, reconcile } = harness([
      { id: 'proactive:briefing:daily' },
      { id: 'proactive:digest:daily' },
    ]);

    await reconcile(config({ enabled: false }), null);

    expect(queue.getJobSchedulers).toHaveBeenCalledOnce();
    expect(queue.removeJobScheduler).toHaveBeenNthCalledWith(1, 'proactive:briefing:daily');
    expect(queue.removeJobScheduler).toHaveBeenNthCalledWith(2, 'proactive:digest:daily');
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
  });
});
