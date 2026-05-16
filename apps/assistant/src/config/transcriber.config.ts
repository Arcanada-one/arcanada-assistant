import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const envSchema = z.object({
  MODEL_CONNECTOR_BASE_URL: z.string().url(),
  MODEL_CONNECTOR_API_KEY: z.string().min(1, 'MODEL_CONNECTOR_API_KEY required for STT'),
  MODEL_CONNECTOR_STT_DEFAULT_MODEL: z.string().min(1).optional(),
  TRANSCRIBER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  ECOSYSTEM_TRANSCRIBER_INTEGRATION: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v !== 'false'),
});

export interface TranscriberConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  timeoutMs: number;
  integrationEnabled: boolean;
}

export const TRANSCRIBER_CONFIG = 'transcriber';

export default registerAs(TRANSCRIBER_CONFIG, (): TranscriberConfig => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid Transcriber configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return {
    baseUrl: parsed.data.MODEL_CONNECTOR_BASE_URL,
    apiKey: parsed.data.MODEL_CONNECTOR_API_KEY,
    ...(parsed.data.MODEL_CONNECTOR_STT_DEFAULT_MODEL
      ? { defaultModel: parsed.data.MODEL_CONNECTOR_STT_DEFAULT_MODEL }
      : {}),
    timeoutMs: parsed.data.TRANSCRIBER_TIMEOUT_MS,
    integrationEnabled: parsed.data.ECOSYSTEM_TRANSCRIBER_INTEGRATION,
  };
});
