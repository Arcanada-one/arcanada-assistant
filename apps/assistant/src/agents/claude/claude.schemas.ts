import { z } from 'zod';

// ARCA-0011 — Claude completion path via Model Connector `/execute` against
// OpenRouter. Mirrors `transcriber.schemas.ts` shape and the canonical MC
// envelope. Image bytes leave the assistant inline as base64 `data:` URLs
// (Telegram CDN URLs are short-lived + unsigned so they cannot be forwarded).

export const ClaudeContentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string().min(1).max(100_000),
  }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z
        .string()
        .regex(/^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  }),
]);

export type ClaudeContentBlock = z.infer<typeof ClaudeContentBlockSchema>;

export const ClaudeCompletionRequestSchema = z
  .object({
    systemPrompt: z.string().min(1),
    content: z.union([
      z.string().min(1).max(100_000),
      z.array(ClaudeContentBlockSchema).min(1).max(20),
    ]),
    model: z.string().min(1).optional(),
    requestId: z.string().uuid().optional(),
    maxTokens: z.number().int().min(1).max(64_000).optional(),
  })
  .strict();

export type ClaudeCompletionRequest = z.infer<typeof ClaudeCompletionRequestSchema>;

// MC `/execute` success response shape (subset relevant to the assistant).
export const McExecuteSuccessSchema = z
  .object({
    id: z.string().min(1),
    connector: z.string().min(1),
    model: z.string().min(1),
    result: z.string(),
    usage: z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
    latencyMs: z.number().nonnegative(),
    status: z.enum(['success', 'error', 'timeout', 'rate_limited']),
    error: z
      .object({
        type: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        recommendation: z.string(),
      })
      .optional(),
  })
  .passthrough();

export type McExecuteSuccess = z.infer<typeof McExecuteSuccessSchema>;

export const McExecuteErrorEnvelopeSchema = z
  .object({
    statusCode: z.number().int(),
    error_code: z.string().min(1).optional(),
    message: z.string().min(1),
  })
  .passthrough();

export const ClaudeResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    reply: z.string(),
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    latencyMs: z.number().nonnegative(),
    requestId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.string().min(1),
    statusCode: z.number().int().optional(),
    errorCode: z.string().optional(),
    detail: z.string().optional(),
  }),
]);

export type ClaudeResult = z.infer<typeof ClaudeResultSchema>;
