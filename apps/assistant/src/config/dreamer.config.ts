import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const envSchema = z.object({
  DREAMER_BASE_URL: z.string().url().optional(),
  DREAMER_API_TOKEN: z.string().min(1).optional(),
  DREAMER_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  ECOSYSTEM_DREAMER_LIVE: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),
});

export interface DreamerConfig {
  baseUrl?: string;
  apiToken?: string;
  timeoutMs: number;
  live: boolean;
}

export const DREAMER_CONFIG = 'dreamer';

export default registerAs(DREAMER_CONFIG, (): DreamerConfig => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid Dreamer configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return {
    ...(parsed.data.DREAMER_BASE_URL ? { baseUrl: parsed.data.DREAMER_BASE_URL } : {}),
    ...(parsed.data.DREAMER_API_TOKEN ? { apiToken: parsed.data.DREAMER_API_TOKEN } : {}),
    timeoutMs: parsed.data.DREAMER_TIMEOUT_MS,
    live: parsed.data.ECOSYSTEM_DREAMER_LIVE,
  };
});
