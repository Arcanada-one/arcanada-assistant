import { z } from 'zod';

import { predicateAstSchema, type PredicateAst } from './predicate-ast.schema.js';

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

export const IDEMPOTENCY_STRATEGIES = ['redis_nx', 'bullmq_job_id', 'uuid_v7'] as const;
export type IdempotencyStrategy = (typeof IDEMPOTENCY_STRATEGIES)[number];

export const ApprovalPolicyEntrySchema = z
  .object({
    tool_name: z.string().regex(TOOL_NAME_RE, 'tool_name must match /^[a-z][a-z0-9_]*$/'),
    requires_approval: z.union([z.boolean(), z.literal('conditional')]),
    condition: predicateAstSchema.optional(),
    approval_timeout_ms: z
      .number()
      .int()
      .min(10_000, 'approval_timeout_ms ≥ 10 000 (10 s)')
      .max(3_600_000, 'approval_timeout_ms ≤ 3 600 000 (1 h)')
      .default(300_000),
    idempotency_strategy: z.enum(IDEMPOTENCY_STRATEGIES).default('redis_nx'),
    approve_requires: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine((entry) => entry.requires_approval !== 'conditional' || entry.condition !== undefined, {
    message: 'conditional requires non-empty condition',
    path: ['condition'],
  });

export type ApprovalPolicyEntry = z.infer<typeof ApprovalPolicyEntrySchema>;

export const ApprovalPolicySchema = z
  .object({
    version: z.literal(1),
    tools: z.array(ApprovalPolicyEntrySchema).min(1, 'policy must declare ≥1 tool'),
  })
  .strict()
  .refine((policy) => new Set(policy.tools.map((t) => t.tool_name)).size === policy.tools.length, {
    message: 'duplicate tool_name forbidden',
    path: ['tools'],
  });

export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export interface ApprovalDecision {
  requiresApproval: boolean;
  matchedTool?: string;
  entry?: ApprovalPolicyEntry;
  matchedCondition?: PredicateAst;
}
