import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * Namespace «scrutator» внутри ConfigService. Источник:
 *   - dev/CI:    `.env` / process.env (см. .env.example).
 *   - prod:      ENV-инжекция в runtime; нет Vault-секретов потому что
 *                Scrutator inbound auth не валидирует — boundary control =
 *                Tailscale ACL на arcana-db (см. ARCA-0008-fixtures.md § Auth probe).
 *
 * Ключевые отличия от opsBot config:
 *   - НЕТ apiKey (network-policy auth, не application-level).
 *   - URL может быть http:// (для arcana-db hostname / localhost) — Tailscale обеспечивает
 *     транспортную безопасность.
 */
const scrutatorEnvSchema = z.object({
  SCRUTATOR_BASE_URL: z.string().min(1, 'SCRUTATOR_BASE_URL required').url(),
  SCRUTATOR_LTM_NAMESPACE: z.string().min(1, 'SCRUTATOR_LTM_NAMESPACE required'),
  ECOSYSTEM_SCRUTATOR_INTEGRATION: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v !== 'false'),
});

export interface ScrutatorConfig {
  baseUrl: string;
  ltmNamespace: string;
  integrationEnabled: boolean;
}

export const SCRUTATOR_CONFIG = 'scrutator';

export default registerAs(SCRUTATOR_CONFIG, (): ScrutatorConfig => {
  const parsed = scrutatorEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid Scrutator configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return {
    baseUrl: parsed.data.SCRUTATOR_BASE_URL,
    ltmNamespace: parsed.data.SCRUTATOR_LTM_NAMESPACE,
    integrationEnabled: parsed.data.ECOSYSTEM_SCRUTATOR_INTEGRATION,
  };
});
