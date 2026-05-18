import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { IOpsBotClient } from '@arcanada/core';

import { OPS_BOT_CLIENT } from '../agents/ops-agent/ops-agent.service.js';
import { RedisService } from '../database/redis.service.js';

import { ProactiveMetricsService } from './proactive-metrics.service.js';
import {
  PROACTIVE_TELEGRAM_SENDER,
  type IProactiveTelegramSender,
} from './proactive-telegram.sender.js';
import type { DispatchInput, DispatchResult, ProactiveKind } from './proactive.types.js';

const SETNX_TTL_SECONDS = 36 * 3600;

export class TelegramRateLimitError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number, description: string) {
    super(`telegram rate-limit: ${description}`);
    this.name = 'TelegramRateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

export class TelegramTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramTransientError';
  }
}

@Injectable()
export class ProactiveDispatcherService {
  private readonly logger = new Logger(ProactiveDispatcherService.name);
  private readonly redis: Redis;
  private readonly fallbackPlainTextOnMdError: boolean;
  private readonly selfHealThreshold: number;

  constructor(
    redisService: RedisService,
    @Inject(PROACTIVE_TELEGRAM_SENDER) private readonly sender: IProactiveTelegramSender,
    @Inject(OPS_BOT_CLIENT) private readonly opsBot: IOpsBotClient,
    private readonly metrics: ProactiveMetricsService,
  ) {
    this.redis = redisService.client;
    this.fallbackPlainTextOnMdError = true;
    this.selfHealThreshold = 3;
  }

  static withDeps(deps: {
    redis: Redis;
    sender: IProactiveTelegramSender;
    opsBot: IOpsBotClient;
    metrics: ProactiveMetricsService;
    fallbackPlainTextOnMdError?: boolean;
    selfHealThreshold?: number;
  }): ProactiveDispatcherService {
    const svc = Object.create(ProactiveDispatcherService.prototype) as ProactiveDispatcherService;
    Object.assign(svc, {
      logger: new Logger(ProactiveDispatcherService.name),
      redis: deps.redis,
      sender: deps.sender,
      opsBot: deps.opsBot,
      metrics: deps.metrics,
      fallbackPlainTextOnMdError: deps.fallbackPlainTextOnMdError ?? true,
      selfHealThreshold: deps.selfHealThreshold ?? 3,
    });
    return svc;
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const idemKey = this.idemKey(input.kind, input.runDate);
    const claim = await this.redis.set(idemKey, '1', 'EX', SETNX_TTL_SECONDS, 'NX');
    if (claim === null) {
      this.metrics.inc(input.kind, 'skipped');
      this.logger.log(
        `dispatch skipped (already sent today) kind=${input.kind} run_date=${input.runDate}`,
      );
      return { status: 'skipped', reason: 'already-sent' };
    }
    try {
      const result = await this.attemptSend(input);
      await this.resetFailureCounter(input.kind);
      this.metrics.inc(input.kind, 'sent');
      this.logger.log(
        `dispatch sent kind=${input.kind} run_date=${input.runDate} message_id=${result.messageId}`,
      );
      return { status: 'sent', messageId: result.messageId };
    } catch (err) {
      await this.redis.del(idemKey);
      await this.recordFailure(input.kind, err);
      this.metrics.inc(input.kind, 'failed');
      throw err;
    }
  }

  private async attemptSend(input: DispatchInput): Promise<{ messageId: number }> {
    const first = await this.sender.send(input.chatId, input.text, 'MarkdownV2');
    if (first.ok) return { messageId: first.messageId };
    if (first.errorCode === 400 && this.shouldFallbackToPlain(first.description)) {
      this.logger.warn(
        `markdown parse failed, retrying plain-text kind=${input.kind}: ${first.description}`,
      );
      const fallback = await this.sender.send(input.chatId, this.toPlain(input.text), null);
      if (fallback.ok) return { messageId: fallback.messageId };
      throw this.classifyError(fallback);
    }
    throw this.classifyError(first);
  }

  private shouldFallbackToPlain(description: string): boolean {
    if (!this.fallbackPlainTextOnMdError) return false;
    return /can't parse entities|parse_mode/i.test(description);
  }

  private toPlain(md: string): string {
    return md.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1').replace(/[*_`]/g, '');
  }

  private classifyError(err: {
    errorCode: number;
    description: string;
    retryAfter?: number;
  }): Error {
    if (err.errorCode === 429) {
      return new TelegramRateLimitError(err.retryAfter ?? 60, err.description);
    }
    if (err.errorCode >= 500) {
      return new TelegramTransientError(`telegram ${err.errorCode}: ${err.description}`);
    }
    return new Error(`telegram ${err.errorCode}: ${err.description}`);
  }

  private idemKey(kind: ProactiveKind, runDate: string): string {
    return `proactive:${kind}:${runDate}:sent`;
  }

  private failureCounterKey(kind: ProactiveKind): string {
    return `proactive:${kind}:consecutive_failures`;
  }

  private async recordFailure(kind: ProactiveKind, err: unknown): Promise<void> {
    const key = this.failureCounterKey(kind);
    const count = await this.redis.incr(key);
    await this.redis.expire(key, 24 * 3600);
    this.logger.warn(`dispatch failed kind=${kind} count=${count}: ${(err as Error).message}`);
    if (count >= this.selfHealThreshold) {
      await this.emitSelfHeal(kind, count, (err as Error).message);
    }
  }

  private async resetFailureCounter(kind: ProactiveKind): Promise<void> {
    await this.redis.del(this.failureCounterKey(kind));
  }

  private async emitSelfHeal(kind: ProactiveKind, count: number, lastError: string): Promise<void> {
    try {
      await this.opsBot.emitEvent({
        service: 'arcanada-assistant',
        category: 'self_heal',
        severity: 'warning',
        message: `proactive-dispatcher ${kind}: ${count} consecutive failures, last error: ${lastError}`,
        context: {
          component: 'proactive-dispatcher',
          kind,
          consecutive_failures: count,
          last_error: lastError,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.error(`self_heal emit failed: ${(err as Error).message}`);
    }
  }
}
