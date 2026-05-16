import { describe, expect, it, vi } from 'vitest';

import { parseApprovalPolicy } from './approval-policy.loader.js';
import { ApprovalService } from './approval.service.js';
import type { RedisIdempotencyService } from './redis-idempotency.service.js';

const POLICY_YAML = `
version: 1
tools:
  - tool_name: task_create
    requires_approval: true
    approval_timeout_ms: 60000
  - tool_name: task_get
    requires_approval: false
`;

function makeRedisStub(overrides: Partial<RedisIdempotencyService> = {}): RedisIdempotencyService {
  return {
    createEnvelope: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue('taken'),
    readClaim: vi.fn().mockResolvedValue({
      decision: 'approve',
      decided_by: 'user-123',
      decided_at: '1731788000',
      envelope: JSON.stringify({ tool_name: 'task_create', payload: {} }),
    }),
    readEnvelope: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as RedisIdempotencyService;
}

describe('ApprovalService', () => {
  const policy = parseApprovalPolicy(POLICY_YAML);

  it('skips approval for read tool', async () => {
    const redis = makeRedisStub();
    const svc = ApprovalService.withDeps(policy, redis);
    const proposal = await svc.propose('task_get', { id: 'x' });
    expect(proposal.kind).toBe('approval_not_required');
    expect(redis.createEnvelope).not.toHaveBeenCalled();
  });

  it('proposes approval and stores envelope for write tool', async () => {
    const redis = makeRedisStub();
    const svc = ApprovalService.withDeps(policy, redis);
    const proposal = await svc.propose('task_create', { title: 'todo' });
    expect(proposal.kind).toBe('approval_required');
    if (proposal.kind !== 'approval_required') return;
    expect(proposal.approveCallback).toMatch(/^apr:v1:a:[0-9a-f-]+$/);
    expect(proposal.rejectCallback).toMatch(/^apr:v1:r:[0-9a-f-]+$/);
    expect(proposal.timeoutMs).toBe(60_000);
    expect(redis.createEnvelope).toHaveBeenCalledWith(
      proposal.pendingId,
      expect.stringContaining('"tool_name":"task_create"'),
      60_000,
    );
  });

  it('proposes approval for unknown tool (fail-closed)', async () => {
    const redis = makeRedisStub();
    const svc = ApprovalService.withDeps(policy, redis);
    const proposal = await svc.propose('totally_unknown_tool', { x: 1 });
    expect(proposal.kind).toBe('approval_required');
  });

  it('claim "taken" returns approved or rejected per decision', async () => {
    const redis = makeRedisStub();
    const svc = ApprovalService.withDeps(policy, redis);
    const approved = await svc.claim('id', 'approve', 'user-1');
    expect(approved.kind).toBe('approved');
    const rejected = await svc.claim('id', 'reject', 'user-1');
    expect(rejected.kind).toBe('rejected');
  });

  it('claim "already" returns already_decided', async () => {
    const redis = makeRedisStub({ claim: vi.fn().mockResolvedValue('already') });
    const svc = ApprovalService.withDeps(policy, redis);
    const result = await svc.claim('id', 'approve', 'user-1');
    expect(result.kind).toBe('already_decided');
  });

  it('claim "expired" returns expired', async () => {
    const redis = makeRedisStub({ claim: vi.fn().mockResolvedValue('expired') });
    const svc = ApprovalService.withDeps(policy, redis);
    const result = await svc.claim('id', 'approve', 'user-1');
    expect(result.kind).toBe('expired');
  });
});
