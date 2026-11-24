import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

integration('ProactiveModule BullMQ 6 Redis scheduler no-op', () => {
  let queue: Queue;
  beforeAll(async () => {
    const url = new URL(redisUrl!);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname))
      throw new Error('REDIS_URL must point to loopback Redis');
    queue = new Queue(queueName, {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        db: Number(url.pathname.slice(1) || 0),
      },
      prefix: 'bull',
    });
    for (const id of schedulerIds) await queue.removeJobScheduler(id);
    await queue.upsertJobScheduler(
      schedulerIds[0]!,
      { pattern: '0 8 * * *', tz: 'Europe/Istanbul' },
      { name: 'briefing', data: { kind: 'briefing' } },
    );
    await queue.upsertJobScheduler(
      schedulerIds[1]!,
      { pattern: '0 21 * * *', tz: 'Europe/Istanbul' },
      { name: 'digest', data: { kind: 'digest' } },
    );
  });
  afterAll(async () => {
    if (!queue) return;
    for (const id of schedulerIds) await queue.removeJobScheduler(id);
    await queue.close();
  });

  it('preserves current scheduler keys and delayed jobs with zero legacy removals', async () => {
    const module = new ProactiveModule({} as ConfigService, {} as never, {} as never, queue);
    const internals = module as unknown as {
      reconcile(next: ProactiveConfig, previous: null): Promise<void>;
      logger: { log(message: string): void };
    };
    const log = vi.spyOn(internals.logger, 'log');
    const beforeSchedulers = await queue.getJobSchedulers();
    const beforeDelayed = await queue.getDelayed();
    expect(beforeSchedulers.map((item) => item.key)).toEqual(expect.arrayContaining(schedulerIds));
    expect(beforeDelayed.map((job) => job.id)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^repeat:proactive:briefing:daily:\d+$/),
        expect.stringMatching(/^repeat:proactive:digest:daily:\d+$/),
      ]),
    );

    await internals.reconcile(config(), null);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('legacy_repeatables_removed=0'));
    expect((await queue.getJobSchedulers()).map((item) => item.key)).toEqual(
      expect.arrayContaining(schedulerIds),
    );
    expect((await queue.getDelayed()).map((job) => job.id)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^repeat:proactive:briefing:daily:\d+$/),
        expect.stringMatching(/^repeat:proactive:digest:daily:\d+$/),
      ]),
    );
  });
});
