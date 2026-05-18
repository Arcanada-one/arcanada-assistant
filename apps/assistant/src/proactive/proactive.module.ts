import {
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Worker, type Queue, type Job } from 'bullmq';

import { OpsAgentModule } from '../agents/ops-agent/ops-agent.module.js';
import { DatabaseModule } from '../database/database.module.js';

import { BriefingAggregator } from './briefing.aggregator.js';
import { DatarimReaderService } from './datarim-reader.service.js';
import { DigestAggregator } from './digest.aggregator.js';
import { ProactiveConfigService } from './proactive-config.service.js';
import { PROACTIVE_QUEUE, ProactiveController } from './proactive.controller.js';
import { ProactiveDispatcherService } from './proactive-dispatcher.service.js';
import { ProactiveMetricsService } from './proactive-metrics.service.js';
import { ProactiveProcessor } from './proactive.processor.js';
import { PROACTIVE_TELEGRAM_SENDER, ProactiveTelegramSender } from './proactive-telegram.sender.js';
import type { ProactiveConfig, ProactiveKind } from './proactive.types.js';

const QUEUE_NAME = 'proactive';
const BRIEFING_JOB_ID = 'proactive:briefing:daily';
const DIGEST_JOB_ID = 'proactive:digest:daily';

function parseRedisUrl(url: string): {
  host: string;
  port: number;
  db?: number;
  password?: string;
  username?: string;
} {
  const u = new URL(url);
  const out: {
    host: string;
    port: number;
    db?: number;
    password?: string;
    username?: string;
  } = {
    host: u.hostname,
    port: Number(u.port || 6379),
  };
  // BullMQ uses ioredis; both honour password/username on the connection
  // descriptor. URL.password is percent-decoded by the WHATWG URL parser.
  if (u.password) out.password = decodeURIComponent(u.password);
  if (u.username) out.username = decodeURIComponent(u.username);
  const dbPart = u.pathname.replace(/^\//, '');
  if (dbPart) out.db = Number(dbPart);
  return out;
}

@Module({
  imports: [
    DatabaseModule,
    OpsAgentModule,
    BullModule.registerQueueAsync({
      name: QUEUE_NAME,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: parseRedisUrl(config.getOrThrow<string>('REDIS_URL')),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { age: 24 * 3600, count: 100 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      }),
    }),
  ],
  controllers: [ProactiveController],
  providers: [
    DatarimReaderService,
    {
      provide: PROACTIVE_TELEGRAM_SENDER,
      useClass: ProactiveTelegramSender,
    },
    ProactiveMetricsService,
    BriefingAggregator,
    DigestAggregator,
    ProactiveDispatcherService,
    ProactiveProcessor,
    {
      provide: ProactiveConfigService,
      useFactory: (config: ConfigService) => {
        const path = config.get<string>('PROACTIVE_CONFIG_PATH');
        if (!path) {
          return ProactiveConfigService.withSource({ read: () => Promise.resolve('') }, 0);
        }
        const pollMsRaw = config.get<string>('PROACTIVE_CONFIG_POLL_MS');
        const pollMs = pollMsRaw ? Number(pollMsRaw) : undefined;
        return ProactiveConfigService.fromPath(path, pollMs);
      },
      inject: [ConfigService],
    },
    {
      provide: PROACTIVE_QUEUE,
      useExisting: getQueueToken(QUEUE_NAME),
    },
  ],
  exports: [ProactiveProcessor, ProactiveConfigService],
})
export class ProactiveModule implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ProactiveModule.name);
  private worker: Worker | null = null;
  private currentBriefingCron: string | null = null;
  private currentDigestCron: string | null = null;
  private currentTz: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly configService: ProactiveConfigService,
    private readonly processor: ProactiveProcessor,
    @Inject(getQueueToken(QUEUE_NAME)) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get<string>('PROACTIVE_CONFIG_PATH')) {
      this.logger.warn('PROACTIVE_CONFIG_PATH unset — proactive module idle');
      return;
    }
    try {
      await this.configService.start();
    } catch (err) {
      this.logger.error(`proactive initial config load failed: ${(err as Error).message}`);
      return;
    }
    this.configService.onChange((next, prev) => {
      this.reconcile(next, prev).catch((err) => {
        this.logger.error(`proactive reconcile failed: ${(err as Error).message}`);
      });
    });
    const snap = this.configService.snapshot();
    if (snap) await this.reconcile(snap, null);
    this.startWorker();
  }

  async onModuleDestroy(): Promise<void> {
    this.configService.stop();
    if (this.worker) await this.worker.close();
  }

  private startWorker(): void {
    if (this.worker) return;
    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        const kind = (job.data as { kind: ProactiveKind }).kind;
        return this.processor.process({ kind });
      },
      { connection: parseRedisUrl(this.config.getOrThrow<string>('REDIS_URL')) },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`worker job ${job?.id} failed: ${err.message}`);
    });
  }

  private async reconcile(next: ProactiveConfig, _prev: ProactiveConfig | null): Promise<void> {
    if (!next.enabled) {
      this.logger.warn('proactive disabled by config — removing repeatable jobs');
      await this.removeRepeatables();
      return;
    }
    await this.reconcileChannel('briefing', next.channels.briefing, next.timezone);
    await this.reconcileChannel('digest', next.channels.digest, next.timezone);
    this.currentTz = next.timezone;
  }

  private async reconcileChannel(
    kind: ProactiveKind,
    channel: { enabled: boolean; cron: string },
    tz: string,
  ): Promise<void> {
    const jobId = kind === 'briefing' ? BRIEFING_JOB_ID : DIGEST_JOB_ID;
    const tracked = kind === 'briefing' ? this.currentBriefingCron : this.currentDigestCron;
    if (!channel.enabled) {
      await this.queue
        .removeRepeatableByKey(`${kind}:${tracked ?? channel.cron}::${tz}`)
        .catch(() => undefined);
      if (kind === 'briefing') this.currentBriefingCron = null;
      else this.currentDigestCron = null;
      this.logger.log(`channel ${kind} disabled — repeatable removed`);
      return;
    }
    if (tracked === channel.cron && this.currentTz === tz) return;
    if (tracked) {
      await this.queue
        .removeRepeatableByKey(`${kind}:${tracked}::${this.currentTz ?? tz}`)
        .catch(() => undefined);
    }
    await this.queue.add(kind, { kind }, { repeat: { pattern: channel.cron, tz }, jobId });
    if (kind === 'briefing') this.currentBriefingCron = channel.cron;
    else this.currentDigestCron = channel.cron;
    this.logger.log(`channel ${kind} scheduled — cron="${channel.cron}" tz="${tz}"`);
  }

  private async removeRepeatables(): Promise<void> {
    const repeatables = await this.queue.getRepeatableJobs();
    for (const r of repeatables) {
      await this.queue.removeRepeatableByKey(r.key).catch(() => undefined);
    }
    this.currentBriefingCron = null;
    this.currentDigestCron = null;
  }
}
