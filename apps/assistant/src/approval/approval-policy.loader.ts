import { readFile } from 'node:fs/promises';

import { JSON_SCHEMA, load as yamlLoad } from 'js-yaml';

import {
  ApprovalPolicySchema,
  type ApprovalPolicy,
  type ApprovalPolicyEntry,
  type ApprovalDecision,
} from './approval-policy.schema.js';
import { evaluatePredicate } from './predicate-eval.js';

export class ApprovalPolicyLoadError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ApprovalPolicyLoadError';
    this.cause = cause;
  }
}

export async function loadApprovalPolicyFromFile(path: string): Promise<ApprovalPolicy> {
  let raw: string;
  try {
    // Path comes from operator-controlled env var / DI factory default;
    // not user-supplied input. Suppressing the non-literal-filename rule here is safe.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new ApprovalPolicyLoadError(`unable to read policy file: ${path}`, err);
  }
  return parseApprovalPolicy(raw);
}

export function parseApprovalPolicy(raw: string): ApprovalPolicy {
  let doc: unknown;
  try {
    doc = yamlLoad(raw, { schema: JSON_SCHEMA });
  } catch (err) {
    throw new ApprovalPolicyLoadError(
      `unable to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  const parsed = ApprovalPolicySchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ApprovalPolicyLoadError(`invalid approval-policy: ${issues}`);
  }
  return parsed.data;
}

/**
 * Pure, in-memory evaluator. `payload` is supplied by the caller (the predicate
 * receives it under `payload.*` paths). Fail-closed: unknown tool ⇒ defaults to
 * `requiresApproval: true` so any new write-tool blocks automatically until
 * declared.
 */
export function decideApproval(
  policy: ApprovalPolicy,
  toolName: string,
  payload: unknown,
): ApprovalDecision {
  const entry = policy.tools.find((t) => t.tool_name === toolName);
  if (!entry) {
    return { requiresApproval: true };
  }
  if (entry.requires_approval === true) {
    return toDecision(entry, true);
  }
  if (entry.requires_approval === false) {
    return toDecision(entry, false);
  }
  if (entry.condition === undefined) {
    // schema guards against this, defense-in-depth fallback
    return toDecision(entry, true);
  }
  const matches = evaluatePredicate(entry.condition, {
    payload,
    tool: { name: toolName },
  });
  return {
    requiresApproval: matches,
    matchedTool: entry.tool_name,
    entry,
    matchedCondition: entry.condition,
  };
}

function toDecision(entry: ApprovalPolicyEntry, requires: boolean): ApprovalDecision {
  return { requiresApproval: requires, matchedTool: entry.tool_name, entry };
}
