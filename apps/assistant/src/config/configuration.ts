import { z } from 'zod';

const httpsUrl = z.string().url().refine((u) => u.startsWith('https://'), {
  message: 'must be https://',
});

const httpOrHttpsUrl = z.string().url();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

export const configurationSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3800),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL required'),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .min(32, 'TELEGRAM_WEBHOOK_SECRET must be ≥32 chars'),
  TELEGRAM_WEBHOOK_PATH: z.string().startsWith('/').default('/webhook/telegram'),

  AUTH_ARCANA_BASE_URL: httpsUrl,
  AUTH_ARCANA_JWKS_URL: httpsUrl,
  AUTH_ARCANA_JWT_ISSUER: httpsUrl,
  AUTH_ARCANA_JWT_AUDIENCE: z.string().min(1),

  MODEL_CONNECTOR_BASE_URL: httpOrHttpsUrl,
  MODEL_CONNECTOR_DEFAULT_MODEL: z.string().min(1),

  SCRUTATOR_BASE_URL: httpOrHttpsUrl,
  SCRUTATOR_LTM_NAMESPACE: z.string().min(1),

  OPSBOT_BASE_URL: httpsUrl,
  OPSBOT_API_KEY: z.string().min(1),

  BRIEFING_TIMEZONE: z.string().min(1).default('Europe/Istanbul'),
  BRIEFING_MORNING_TIME: hhmm.default('08:00'),
  BRIEFING_EVENING_TIME: hhmm.default('21:00'),
});

export type AppConfig = z.infer<typeof configurationSchema>;

export function validateConfig(env: Record<string, unknown>): AppConfig {
  const result = configurationSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}
