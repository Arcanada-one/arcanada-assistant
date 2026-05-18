import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { RedisService } from '../database/redis.service.js';

const ENVELOPE_PREFIX = 'approval:';
const CLAIM_PREFIX = 'approval:claim:';
const CLAIM_TTL_SECONDS = 86_400;

/**
 * Atomic single-tap claim — the only way to enforce idempotency on Telegram
 * inline-button taps that may arrive twice (double-click, retry, mirror
 * webhook). Implemented as a Lua script so envelope read, claim write and
 * envelope delete are a single Redis transaction.
 *
 * Script protocol:
 *   KEYS[1]  approval:<uuid>            ← pending envelope (TTL = timeout)
 *   KEYS[2]  approval:claim:<uuid>      ← post-decision audit row (TTL 24 h)
 *   ARGV[1]  "approve" | "reject"
 *   ARGV[2]  decided-by (Telegram user.id string)
 *   ARGV[3]  decided-at (unix seconds string)
 *
 * Returns: "taken" | "already" | "expired".
 */
export const CLAIM_LUA = `
local envelope = redis.call("GET", KEYS[1])
if not envelope then return "expired" end
local existing = redis.call("GET", KEYS[2])
if existing then return "already" end
redis.call("SET", KEYS[2], cjson.encode({decision=ARGV[1], decided_by=ARGV[2], decided_at=ARGV[3], envelope=envelope}), "EX", ${CLAIM_TTL_SECONDS})
redis.call("DEL", KEYS[1])
return "taken"
`.trim();

export type ClaimOutcome = 'taken' | 'already' | 'expired';

export interface ClaimRecord {
  decision: 'approve' | 'reject';
  decided_by: string;
  decided_at: string;
  envelope: string;
}

@Injectable()
export class RedisIdempotencyService {
  private readonly logger = new Logger(RedisIdempotencyService.name);
  private readonly redis: Redis;
  private claimSha?: string;

  constructor(redisService: RedisService) {
    this.redis = redisService.client;
  }

  /** Test-only constructor accepting a raw Redis client (e.g. ioredis-mock). */
  static withRedis(client: Redis): RedisIdempotencyService {
    const svc = Object.create(RedisIdempotencyService.prototype) as RedisIdempotencyService;
    (svc as unknown as { logger: Logger }).logger = new Logger(RedisIdempotencyService.name);
    (svc as unknown as { redis: Redis }).redis = client;
    return svc;
  }

  async createEnvelope(uuid: string, envelopeJson: string, timeoutMs: number): Promise<void> {
    const ttlSeconds = Math.max(1, Math.floor(timeoutMs / 1000));
    await this.redis.set(this.envelopeKey(uuid), envelopeJson, 'EX', ttlSeconds);
  }

  async claim(
    uuid: string,
    decision: 'approve' | 'reject',
    decidedBy: string,
    decidedAt: number,
  ): Promise<ClaimOutcome> {
    const args = [
      this.envelopeKey(uuid),
      this.claimKey(uuid),
      decision,
      decidedBy,
      String(decidedAt),
    ];
    // Use EVALSHA on hot path; lazily load script on first call.
    if (!this.claimSha) {
      this.claimSha = (await this.redis.script('LOAD', CLAIM_LUA)) as string;
    }
    try {
      const result = await this.redis.evalsha(
        this.claimSha,
        2,
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
      );
      return this.parseOutcome(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes('NOSCRIPT')) {
        // Script flushed (e.g. SCRIPT FLUSH between calls). Reload + retry once.
        this.claimSha = (await this.redis.script('LOAD', CLAIM_LUA)) as string;
        const result = await this.redis.evalsha(
          this.claimSha,
          2,
          args[0],
          args[1],
          args[2],
          args[3],
          args[4],
        );
        return this.parseOutcome(result);
      }
      throw err;
    }
  }

  async readClaim(uuid: string): Promise<ClaimRecord | null> {
    const raw = await this.redis.get(this.claimKey(uuid));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ClaimRecord;
    } catch (err) {
      this.logger.warn({ uuid, err: errMsg(err) }, 'corrupted approval claim record');
      return null;
    }
  }

  async readEnvelope(uuid: string): Promise<string | null> {
    return this.redis.get(this.envelopeKey(uuid));
  }

  private parseOutcome(result: unknown): ClaimOutcome {
    if (result === 'taken' || result === 'already' || result === 'expired') return result;
    throw new Error(`unexpected claim outcome: ${String(result)}`);
  }

  private envelopeKey(uuid: string): string {
    return `${ENVELOPE_PREFIX}${uuid}`;
  }

  private claimKey(uuid: string): string {
    return `${CLAIM_PREFIX}${uuid}`;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
