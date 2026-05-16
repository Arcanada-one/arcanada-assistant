import IoredisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';

import { CLAIM_LUA, RedisIdempotencyService } from './redis-idempotency.service.js';

function makeService(): { svc: RedisIdempotencyService; client: IoredisMock } {
  const client = new IoredisMock();
  if (typeof client.defineCommand === 'function') {
    client.defineCommand('approvalClaim', { numberOfKeys: 2, lua: CLAIM_LUA });
  }
  const svc = RedisIdempotencyService.withRedis(client as unknown as never);
  return { svc, client };
}

const UUID = '01941d7e-3b22-7c11-9f56-d4e3a8b9c012';

describe('RedisIdempotencyService', () => {
  it('createEnvelope writes a TTL-bound key', async () => {
    const { svc, client } = makeService();
    await svc.createEnvelope(UUID, JSON.stringify({ tool: 'task_create' }), 60_000);
    const raw = await client.get(`approval:${UUID}`);
    expect(raw).toBeTruthy();
    const ttl = await client.ttl(`approval:${UUID}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('readEnvelope returns null for missing key', async () => {
    const { svc } = makeService();
    expect(await svc.readEnvelope('00000000-0000-7000-8000-000000000000')).toBeNull();
  });

  it('readClaim returns null for missing claim record', async () => {
    const { svc } = makeService();
    expect(await svc.readClaim(UUID)).toBeNull();
  });
});
