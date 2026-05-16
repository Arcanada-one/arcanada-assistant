import { describe, expect, it } from 'vitest';

import {
  ApprovalPolicyLoadError,
  decideApproval,
  parseApprovalPolicy,
} from './approval-policy.loader.js';

const VALID_YAML = `
version: 1
tools:
  - tool_name: task_create
    requires_approval: true
  - tool_name: task_get
    requires_approval: false
  - tool_name: task_query
    requires_approval: conditional
    condition:
      "==":
        - {var: payload.where}
        - null
`;

describe('parseApprovalPolicy', () => {
  it('parses a minimal valid policy', () => {
    const policy = parseApprovalPolicy(VALID_YAML);
    expect(policy.version).toBe(1);
    expect(policy.tools).toHaveLength(3);
    expect(policy.tools[0].tool_name).toBe('task_create');
    expect(policy.tools[0].approval_timeout_ms).toBe(300_000);
    expect(policy.tools[0].idempotency_strategy).toBe('redis_nx');
  });

  it('fails closed on duplicate tool_name', () => {
    const dup = `
version: 1
tools:
  - tool_name: task_create
    requires_approval: true
  - tool_name: task_create
    requires_approval: false
`;
    expect(() => parseApprovalPolicy(dup)).toThrow(ApprovalPolicyLoadError);
  });

  it('fails closed on conditional without condition', () => {
    const bad = `
version: 1
tools:
  - tool_name: task_query
    requires_approval: conditional
`;
    expect(() => parseApprovalPolicy(bad)).toThrow(ApprovalPolicyLoadError);
  });

  it('fails closed on bad tool_name format', () => {
    const bad = `
version: 1
tools:
  - tool_name: TaskCreate
    requires_approval: true
`;
    expect(() => parseApprovalPolicy(bad)).toThrow(ApprovalPolicyLoadError);
  });

  it('fails closed on unparseable YAML', () => {
    expect(() => parseApprovalPolicy('::: not yaml :::')).toThrow(ApprovalPolicyLoadError);
  });

  it('fails closed on missing version', () => {
    expect(() =>
      parseApprovalPolicy(`tools:\n  - tool_name: t\n    requires_approval: false\n`),
    ).toThrow(ApprovalPolicyLoadError);
  });
});

describe('decideApproval', () => {
  const policy = parseApprovalPolicy(VALID_YAML);

  it('returns requiresApproval=true for known write tool', () => {
    expect(decideApproval(policy, 'task_create', { title: 'x' }).requiresApproval).toBe(true);
  });

  it('returns requiresApproval=false for known read tool', () => {
    expect(decideApproval(policy, 'task_get', { id: 'x' }).requiresApproval).toBe(false);
  });

  it('returns requiresApproval=true for unknown tool (fail-closed)', () => {
    expect(decideApproval(policy, 'unknown_tool', {}).requiresApproval).toBe(true);
  });

  it('evaluates conditional rule (true branch)', () => {
    const decision = decideApproval(policy, 'task_query', { where: null });
    expect(decision.requiresApproval).toBe(true);
    expect(decision.matchedTool).toBe('task_query');
  });

  it('evaluates conditional rule (false branch)', () => {
    expect(
      decideApproval(policy, 'task_query', { where: 'specific-filter' }).requiresApproval,
    ).toBe(false);
  });
});
