import { z } from 'zod';

export const STT_ALLOWED_MIME = [
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/webm',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
] as const;

export type SttMimeType = (typeof STT_ALLOWED_MIME)[number];

export const TranscribeRequestSchema = z
  .object({
    audio: z.instanceof(Buffer),
    filename: z.string().min(1).default('audio.bin'),
    mimeType: z.enum(STT_ALLOWED_MIME),
    language: z
      .string()
      .regex(/^[a-z]{2}$/, 'language must be ISO 639-1 (e.g. "ru", "en")')
      .optional(),
    model: z.string().min(1).optional(),
    prompt: z.string().max(512).optional(),
    requestId: z.string().uuid().optional(),
  })
  .strict();

export type TranscribeRequest = z.infer<typeof TranscribeRequestSchema>;

export const SttSuccessSchema = z
  .object({
    transcription: z.string(),
    model: z.string().min(1),
    provider: z.string().min(1),
    language: z.string().min(1),
    latency_ms: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative(),
    audio_duration_seconds: z.number().nonnegative(),
    fallback_count: z.number().int().nonnegative(),
    request_id: z.string().min(1),
  })
  .passthrough();

export type SttSuccess = z.infer<typeof SttSuccessSchema>;

export const SttErrorEnvelopeSchema = z
  .object({
    statusCode: z.number().int(),
    error_code: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const SttUnauthorizedEnvelopeSchema = z
  .object({
    statusCode: z.literal(401),
    error: z.literal('Unauthorized'),
    message: z.string().min(1),
  })
  .passthrough();

export type SttErrorEnvelope = z.infer<typeof SttErrorEnvelopeSchema>;

export const TranscribeResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    transcription: z.string(),
    provider: z.string().min(1),
    model: z.string().min(1),
    language: z.string().min(1),
    latencyMs: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    audioDurationSeconds: z.number().nonnegative(),
    requestId: z.string().min(1),
    fallbackCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.string().min(1),
    statusCode: z.number().int().optional(),
    errorCode: z.string().optional(),
    detail: z.string().optional(),
  }),
]);

export type TranscribeResult = z.infer<typeof TranscribeResultSchema>;
