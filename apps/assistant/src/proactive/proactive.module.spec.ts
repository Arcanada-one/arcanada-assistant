import { createHash } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import type { Queue, RepeatableJob } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { ProactiveModule } from './proactive.module.js';
import type { ProactiveConfigService } from './proactive-config.service.js';
import type { ProactiveProcessor } from './proactive.processor.js';
import type { ProactiveConfig, ProactiveKind } from './proactive.types.js';

const SCHEDULER_IDS: Record<ProactiveKind, string> = {
  briefing: 'proactive:briefing:daily',
  digest: 'proactive:digest:daily',
};

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

function legacyRepeatable(
  name: string,
  id: string,
  pattern: string,
  tz = 'Europe/Istanbul',
): RepeatableJob {
  const legacyKey = `${name}:${id}::${tz}:${pattern}`;
  return {
    name,
    id,
    key: createHash('md5').update(legacyKey).digest('hex'),
    endDate: null,
    tz,
    pattern,
  };
}

function harness(initialRepeatables: RepeatableJob[] = [], initialSchedulers: string[] = []) {
  const repeatables = [...initialRepeatables];
  const schedulers = new Set(initialSchedulers);
  const queue = {
    upsertJobScheduler: vi.fn(async (id: string) => {
      schedulers.add(id);
      return {};
    }),
    removeJobScheduler: vi.fn(async (id: string) => schedulers.delete(id)),
    getJobSchedulers: vi.fn(async () => [...schedulers].map((id) => ({ id }))),
    getRepeatableJobs: vi.fn(async () => [...repeatables]),
    removeRepeatableByKey: vi.fn(async (key: string) => {
      const index = repeatables.findIndex((repeatable) => repeatable.key === key);
      if (index < 0) return false;
      repeatables.splice(index, 1);
      return true;
    }),
  };
  const module = new ProactiveModule(
    {} as ConfigService,
    {} as ProactiveConfigService,
    {} as ProactiveProcessor,
    queue as unknown as Queue,
  );
  const internals = module as unknown as {
    reconcile(next: ProactiveConfig, previous: ProactiveConfig | null): Promise<void>;
    logger: { log(message: string): void };
  };
  return {
    queue,
    repeatables,
    schedulers,
    reconcile: internals.reconcile.bind(module),
    log: vi.spyOn(internals.logger, 'log'),
  };
}

describe('ProactiveModule BullMQ 5 scheduler migration', () => {
  it('upserts the stable schedulers and removes only matching legacy keys', async () => {
    const briefing = legacyRepeatable('briefing', SCHEDULER_IDS.briefing, '0 8 * * *');
    const oldBriefingSchedule = legacyRepeatable(
      'briefing',
      SCHEDULER_IDS.briefing,
      '0 7 * * *',
      'UTC',
    );
    const unrelatedSameName = legacyRepeatable('briefing', 'another-consumer', '0 9 * * *');
    const unrelatedName = legacyRepeatable('billing', 'billing:nightly', '0 1 * * *');
    const { queue, repeatables, schedulers, reconcile, log } = harness([
      briefing,
      oldBriefingSchedule,
      unrelatedSameName,
      unrelatedName,
    ]);

    await reconcile(config(), null);

    expect(queue.upsertJobScheduler).toHaveBeenNthCalledWith(
      1,
      SCHEDULER_IDS.briefing,
      { pattern: '0 8 * * *', tz: 'Europe/Istanbul' },
      { name: 'briefing', data: { kind: 'briefing' } },
    );
    expect(queue.upsertJobScheduler).toHaveBeenNthCalledWith(
      2,
      SCHEDULER_IDS.digest,
      { pattern: '0 21 * * *', tz: 'Europe/Istanbul' },
      { name: 'digest', data: { kind: 'digest' } },
    );
    expect(queue.removeRepeatableByKey).toHaveBeenCalledTimes(2);
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith(briefing.key);
    expect(queue.removeRepeatableByKey).toHaveBeenCalledWith(oldBriefingSchedule.key);
    expect(repeatables).toEqual([unrelatedSameName, unrelatedName]);
    expect(schedulers).toEqual(new Set([SCHEDULER_IDS.briefing, SCHEDULER_IDS.digest]));
    expect(log).toHaveBeenCalledWith(
      'scheduler reconciliation complete — schedulers_upserted=2 schedulers_removed=0 legacy_repeatables_removed=2',
    );
  });

  it('is idempotent across startup reconciliations using the stable scheduler ids', async () => {
    const first = harness([
      legacyRepeatable('briefing', SCHEDULER_IDS.briefing, '0 8 * * *'),
      legacyRepeatable('digest', SCHEDULER_IDS.digest, '0 21 * * *'),
    ]);

    await first.reconcile(config(), null);
    const second = harness(first.repeatables, [...first.schedulers]);
    await second.reconcile(config(), null);

    expect(second.schedulers).toEqual(new Set([SCHEDULER_IDS.briefing, SCHEDULER_IDS.digest]));
    expect(second.queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(second.queue.removeRepeatableByKey).not.toHaveBeenCalled();
  });

  it('updates a schedule through its existing scheduler id and removes its prior legacy key', async () => {
    const oldBriefing = legacyRepeatable('briefing', SCHEDULER_IDS.briefing, '0 8 * * *');
    const { queue, repeatables, schedulers, reconcile } = harness(
      [oldBriefing],
      [SCHEDULER_IDS.briefing, SCHEDULER_IDS.digest],
    );
    const next = config({
      channels: {
        ...config().channels,
        briefing: { ...config().channels.briefing, cron: '0 9 * * *' },
      },
    });

    await reconcile(next, null);

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      SCHEDULER_IDS.briefing,
      { pattern: '0 9 * * *', tz: 'Europe/Istanbul' },
      { name: 'briefing', data: { kind: 'briefing' } },
    );
    expect(schedulers).toEqual(new Set([SCHEDULER_IDS.briefing, SCHEDULER_IDS.digest]));
    expect(queue.removeJobScheduler).not.toHaveBeenCalled();
    expect(queue.removeRepeatableByKey).toHaveBeenCalledExactlyOnceWith(oldBriefing.key);
    expect(repeatables).toEqual([]);
  });

  it('removes only known legacy and scheduler ids when the module is disabled', async () => {
    const known = legacyRepeatable('briefing', SCHEDULER_IDS.briefing, '0 8 * * *');
    const unrelated = legacyRepeatable('billing', 'billing:nightly', '0 1 * * *');
    const { queue, repeatables, schedulers, reconcile, log } = harness(
      [known, unrelated],
      [SCHEDULER_IDS.briefing, SCHEDULER_IDS.digest, 'billing:nightly'],
    );

    await reconcile(config({ enabled: false }), null);

    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(2);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(SCHEDULER_IDS.briefing);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(SCHEDULER_IDS.digest);
    expect(schedulers).toEqual(new Set(['billing:nightly']));
    expect(queue.removeRepeatableByKey).toHaveBeenCalledExactlyOnceWith(known.key);
    expect(repeatables).toEqual([unrelated]);
    expect(log).toHaveBeenCalledWith(
      'scheduler reconciliation complete — schedulers_upserted=0 schedulers_removed=2 legacy_repeatables_removed=1',
    );
  });

  it('removes only the disabled channel scheduler and its matching legacy key', async () => {
    const known = legacyRepeatable('briefing', SCHEDULER_IDS.briefing, '0 8 * * *');
    const unrelated = legacyRepeatable('briefing', 'another-consumer', '0 9 * * *');
    const { queue, repeatables, schedulers, reconcile } = harness(
      [known, unrelated],
      [SCHEDULER_IDS.briefing, SCHEDULER_IDS.digest, 'another-consumer'],
    );
    const next = config({
      channels: {
        ...config().channels,
        briefing: { ...config().channels.briefing, enabled: false },
      },
    });

    await reconcile(next, null);

    expect(queue.removeJobScheduler).toHaveBeenCalledExactlyOnceWith(SCHEDULER_IDS.briefing);
    expect(queue.upsertJobScheduler).toHaveBeenCalledExactlyOnceWith(
      SCHEDULER_IDS.digest,
      { pattern: '0 21 * * *', tz: 'Europe/Istanbul' },
      { name: 'digest', data: { kind: 'digest' } },
    );
    expect(schedulers).toEqual(new Set([SCHEDULER_IDS.digest, 'another-consumer']));
    expect(queue.removeRepeatableByKey).toHaveBeenCalledExactlyOnceWith(known.key);
    expect(repeatables).toEqual([unrelated]);
  });
});
