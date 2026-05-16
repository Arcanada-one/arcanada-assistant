import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const envSchema = z.object({
  MUNERA_BASE_URL: z.string().url(),
  MUNERA_API_TOKEN: z.string().min(1, 'MUNERA_API_TOKEN required (Vault-managed JWT)'),
  MUNERA_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ECOSYSTEM_MUNERA_INTEGRATION: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v !== 'false'),
});

export interface MuneraConfig {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
  integrationEnabled: boolean;
}

export const MUNERA_CONFIG = 'munera';

export default registerAs(MUNERA_CONFIG, (): MuneraConfig => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid Munera configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return {
    baseUrl: parsed.data.MUNERA_BASE_URL,
    apiToken: parsed.data.MUNERA_API_TOKEN,
    timeoutMs: parsed.data.MUNERA_TIMEOUT_MS,
    integrationEnabled: parsed.data.ECOSYSTEM_MUNERA_INTEGRATION,
  };
});
