import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProactiveModule } from './proactive.module.js';
import type { ProactiveConfig } from './proactive.types.js';

const redisUrl = process.env.REDIS_URL;
const queueName = 'proactive';
const schedulerIds = ['proactive:briefing:daily', 'proactive:digest:daily'];
const integration = describe.skipIf(!redisUrl);

function config(): ProactiveConfig {
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
  };
}

function moduleFor(queue: Queue): ProactiveModule {
  return new ProactiveModule({} as ConfigService, {} as never, {} as never, queue);
}

integration('ProactiveModule Redis scheduler migration', () => {
  let queue: Queue;
  const ownedRepeatKeys = new Set<string>();

  beforeAll(() => {
    const url = new URL(redisUrl!);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error('REDIS_URL must point to a loopback Redis instance');
    }
    queue = new Queue(queueName, {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        db: Number(url.pathname.slice(1) || 0),
      },
      prefix: 'bull',
    });
  });

  afterAll(async () => {
    if (!queue) return;
    for (const id of schedulerIds) await queue.removeJobScheduler(id);
    for (const repeatable of await queue.getRepeatableJobs()) {
      if (ownedRepeatKeys.has(repeatable.key)) await queue.removeRepeatableByKey(repeatable.key);
    }
    await queue.close();
  });

  it('removes the exact legacy jobs and delayed occurrences, preserves unrelated data, and survives restart', async () => {
    expect(await queue.getRepeatableJobs()).toEqual([]);
    expect(await queue.getJobSchedulers()).toEqual([]);
    expect(await queue.getDelayed()).toEqual([]);

    await queue.add(
      'briefing',
      { kind: 'briefing' },
      { repeat: { pattern: '0 8 * * *', tz: 'Europe/Istanbul' }, jobId: schedulerIds[0] },
    );
    await queue.add(
      'digest',
      { kind: 'digest' },
      { repeat: { pattern: '0 21 * * *', tz: 'Europe/Istanbul' }, jobId: schedulerIds[1] },
    );
    await queue.add(
      'briefing',
      { kind: 'briefing', owner: 'unrelated' },
      { repeat: { pattern: '0 9 * * *', tz: 'Europe/Istanbul' }, jobId: 'another-consumer' },
    );

    const seeded = await queue.getRepeatableJobs();
    for (const repeatable of seeded) ownedRepeatKeys.add(repeatable.key);
    const legacy = seeded.filter(
      (job) =>
        (job.name === 'briefing' && job.pattern === '0 8 * * *') ||
        (job.name === 'digest' && job.pattern === '0 21 * * *'),
    );
    const legacyKeys = new Set(legacy.map((job) => job.key));
    const unrelatedKey = seeded.find(
      (job) => job.name === 'briefing' && job.pattern === '0 9 * * *',
    )?.key;
    expect(unrelatedKey).toBeTruthy();
    expect(legacy).toHaveLength(2);
    expect(legacy.map((job) => job.key)).toEqual(
      expect.arrayContaining([
        'bd9cf17396ac4a9af85444381413d20d',
        '53af50ae884da8a2dd0b074e40ef969f',
      ]),
    );
    const pendingBefore = await queue.getDelayed();
    expect(pendingBefore.filter((job) => legacyKeys.has(job.repeatJobKey ?? ''))).toHaveLength(2);

    await (
      moduleFor(queue) as unknown as {
        reconcile(next: ProactiveConfig, previous: null): Promise<void>;
      }
    ).reconcile(config(), null);
    for (const id of schedulerIds) ownedRepeatKeys.add(id);

    const remaining = await queue.getRepeatableJobs();
    expect(remaining).toHaveLength(3);
    expect(remaining.filter((job) => legacyKeys.has(job.key))).toHaveLength(0);
    expect(remaining.some((job) => job.key === unrelatedKey)).toBe(true);
    expect(remaining.find((job) => job.key === unrelatedKey)).toMatchObject({
      name: 'briefing',
      pattern: '0 9 * * *',
      tz: 'Europe/Istanbul',
    });
    expect(
      (await queue.getDelayed()).filter((job) => legacyKeys.has(job.repeatJobKey ?? '')),
    ).toHaveLength(0);

    await (
      moduleFor(queue) as unknown as {
        reconcile(next: ProactiveConfig, previous: null): Promise<void>;
      }
    ).reconcile(config(), null);
    expect((await queue.getJobSchedulers()).map((scheduler) => scheduler.key)).toEqual(
      expect.arrayContaining(schedulerIds),
    );
    expect((await queue.getRepeatableJobs()).filter((job) => legacyKeys.has(job.key))).toHaveLength(
      0,
    );
  });
});
