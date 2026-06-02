import { registerAs } from '@nestjs/config';
import { z } from 'zod';

import { internalHttpOrHttpsUrl } from './url-schemas.js';

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
  // ARCA-0154: разрешён internal http://opsbot:3600 (docker mesh) в обход
  // публичного 403; публичные хосты по-прежнему требуют https. См. url-schemas.ts.
  OPSBOT_BASE_URL: internalHttpOrHttpsUrl,
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
