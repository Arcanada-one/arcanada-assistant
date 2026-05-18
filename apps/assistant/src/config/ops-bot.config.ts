import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * Namespace «opsBot» внутри ConfigService. Источник:
 *   - dev/CI:    `.env` / process.env (см. .env.example).
 *   - prod:      Vault → kv/arcanada-assistant/ops-bot-api-key (component schema:
 *                api_key, base_url) — инжектируется в env runtime'ом перед стартом
 *                контейнера; standalone vault client deferred ARCA-* (backlog).
 *
 * Component-schema convention из feedback_vault_kv_component_schema.md —
 * Vault хранит компоненты, не URL; consumer собирает финальные параметры здесь.
 */
const opsBotEnvSchema = z.object({
  OPSBOT_BASE_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), {
      message: 'OPSBOT_BASE_URL must be https://',
    }),
  OPSBOT_API_KEY: z.string().min(1, 'OPSBOT_API_KEY required'),
});

export interface OpsBotConfig {
  baseUrl: string;
  apiKey: string;
}

export const OPS_BOT_CONFIG = 'opsBot';

export default registerAs(OPS_BOT_CONFIG, (): OpsBotConfig => {
  const parsed = opsBotEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid OpsBot configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return {
    baseUrl: parsed.data.OPSBOT_BASE_URL,
    apiKey: parsed.data.OPSBOT_API_KEY,
  };
});
