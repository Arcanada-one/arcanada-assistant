import { describe, expect, it } from 'vitest';

import { McExecuteSuccessSchema } from './claude.schemas.js';

/**
 * ARCA-0011 — live MC `/execute` fixture replay. Source: captured from
 * `connector.arcanada.one` against `openrouter` connector during the
 * plan-stage probe (`datarim/tasks/ARCA-0011-fixtures.md` § A baseline
 * and § D OpenRouter multimodal upstream). Schema drift in this test
 * means the assistant client must be re-aligned with MC before shipping.
 */

describe('Claude live-fixture replay', () => {
  it('parses MC 201 success envelope (text-only request)', () => {
    const fixture = {
      id: 'gen-fc66a5b1-9ae6-49f6-b3f3-1f4f9c2b1234',
      connector: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      result: 'Привет! Чем могу помочь?',
      structured: undefined,
      usage: {
        inputTokens: 8,
        outputTokens: 11,
        totalTokens: 19,
        costUsd: 0.000125,
      },
      latencyMs: 412,
      queueWaitMs: 0,
      status: 'success',
    };
    const parsed = McExecuteSuccessSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
  });

  it('parses MC error envelope (unsupported_modality on CLI connector)', () => {
    const fixture = {
      id: 'gen-error-cb-1',
      connector: 'claude-code',
      model: 'unknown',
      result: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      latencyMs: 0,
      queueWaitMs: 0,
      status: 'error',
      error: {
        type: 'unsupported_modality',
        message: "Connector 'claude-code' does not accept ContentBlock[] prompts",
        retryable: false,
        recommendation: 'abort',
      },
    };
    const parsed = McExecuteSuccessSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('error');
      expect(parsed.data.error?.type).toBe('unsupported_modality');
    }
  });
});
