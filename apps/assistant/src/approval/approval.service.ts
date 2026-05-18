import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { decideApproval } from './approval-policy.loader.js';
import type { ApprovalPolicy, ApprovalPolicyEntry } from './approval-policy.schema.js';
import { encodeApprovalCallback } from './telegram-callback.parser.js';
import { RedisIdempotencyService, type ClaimOutcome } from './redis-idempotency.service.js';

export const APPROVAL_POLICY = Symbol.for('APPROVAL_POLICY');

export type ApprovalRequiredOutcome = {
  kind: 'approval_required';
  pendingId: string;
  approveCallback: string;
  rejectCallback: string;
  timeoutMs: number;
  toolName: string;
  payload: unknown;
};

export type ApprovalSkippedOutcome = {
  kind: 'approval_not_required';
  toolName: string;
};

export type ApprovalProposalOutcome = ApprovalRequiredOutcome | ApprovalSkippedOutcome;

export type ApprovalClaimResult =
  | { kind: 'approved'; pendingId: string; decidedBy: string; envelope: unknown }
  | { kind: 'rejected'; pendingId: string; decidedBy: string; envelope: unknown }
  | { kind: 'already_decided'; pendingId: string }
  | { kind: 'expired'; pendingId: string };

@Injectable()
export class ApprovalService {
  constructor(
    private readonly policy: ApprovalPolicy,
    private readonly redis: RedisIdempotencyService,
  ) {}

  /** Static factory used in tests and the DI factory. */
  static withDeps(policy: ApprovalPolicy, redis: RedisIdempotencyService): ApprovalService {
    return new ApprovalService(policy, redis);
  }

  decide(toolName: string, payload: unknown): ReturnType<typeof decideApproval> {
    return decideApproval(this.policy, toolName, payload);
  }

  async propose(toolName: string, payload: unknown): Promise<ApprovalProposalOutcome> {
    const decision = this.decide(toolName, payload);
    if (!decision.requiresApproval) {
      return { kind: 'approval_not_required', toolName };
    }
    const entry: ApprovalPolicyEntry | undefined = decision.entry;
    const timeoutMs = entry?.approval_timeout_ms ?? 300_000;
    const pendingId = uuidv7();
    const envelope = JSON.stringify({
      tool_name: toolName,
      payload,
      timeout_ms: timeoutMs,
      created_at: Date.now(),
      request_id: randomUUID(),
    });
    await this.redis.createEnvelope(pendingId, envelope, timeoutMs);
    return {
      kind: 'approval_required',
      pendingId,
      approveCallback: encodeApprovalCallback(pendingId, 'approve'),
      rejectCallback: encodeApprovalCallback(pendingId, 'reject'),
      timeoutMs,
      toolName,
      payload,
    };
  }

  async claim(
    pendingId: string,
    decision: 'approve' | 'reject',
    decidedBy: string,
  ): Promise<ApprovalClaimResult> {
    const decidedAt = Math.floor(Date.now() / 1000);
    const outcome = await this.redis.claim(pendingId, decision, decidedBy, decidedAt);
    return this.mapOutcome(outcome, pendingId, decision, decidedBy);
  }

  private async mapOutcome(
    outcome: ClaimOutcome,
    pendingId: string,
    decision: 'approve' | 'reject',
    decidedBy: string,
  ): Promise<ApprovalClaimResult> {
    if (outcome === 'expired') return { kind: 'expired', pendingId };
    if (outcome === 'already') return { kind: 'already_decided', pendingId };
    const claim = await this.redis.readClaim(pendingId);
    const envelope = claim?.envelope ? safeJsonParse(claim.envelope) : null;
    return decision === 'approve'
      ? { kind: 'approved', pendingId, decidedBy, envelope }
      : { kind: 'rejected', pendingId, decidedBy, envelope };
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export { decideApproval };
export type { ApprovalPolicy };
