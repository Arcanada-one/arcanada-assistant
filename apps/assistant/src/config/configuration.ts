import { z } from 'zod';

import { internalHttpOrHttpsUrl } from './url-schemas.js';

const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), {
    message: 'must be https://',
  });

const httpOrHttpsUrl = z.string().url();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

export const configurationSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3800),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL required'),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(32, 'TELEGRAM_WEBHOOK_SECRET must be ≥32 chars'),
  TELEGRAM_WEBHOOK_PATH: z.string().startsWith('/').default('/webhook/telegram'),

  AUTH_ARCANA_BASE_URL: httpsUrl,
  AUTH_ARCANA_JWKS_URL: httpsUrl,
  AUTH_ARCANA_JWT_ISSUER: httpsUrl,
  AUTH_ARCANA_JWT_AUDIENCE: z.string().min(1),

  MODEL_CONNECTOR_BASE_URL: httpOrHttpsUrl,
  MODEL_CONNECTOR_DEFAULT_MODEL: z.string().min(1),
  MODEL_CONNECTOR_API_KEY: z.string().min(1, 'MODEL_CONNECTOR_API_KEY required for STT'),
  MODEL_CONNECTOR_STT_DEFAULT_MODEL: z.string().min(1).optional(),
  TRANSCRIBER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  ECOSYSTEM_TRANSCRIBER_INTEGRATION: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),

  SCRUTATOR_BASE_URL: httpOrHttpsUrl,
  SCRUTATOR_LTM_NAMESPACE: z.string().min(1),

  // ARCA-0154: relaxed to allow internal http://opsbot:3600 (docker mesh);
  // public hosts still require https. See url-schemas.ts.
  OPSBOT_BASE_URL: internalHttpOrHttpsUrl,
  OPSBOT_API_KEY: z.string().min(1),
  // ARCA-0007 feature flag: when 'false', OpsAgent is не регистрируется в orchestrator,
  // /status и /agents отвечают «команда временно отключена» через NoAgentForIntentError.
  ECOSYSTEM_OPS_BOT_INTEGRATION: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
  // ARCA-0008 feature flag: when 'false', KnowledgeAgent is не регистрируется,
  // /wiki, /remember, /recall возвращают «команда временно отключена», а dialog-RAG
  // обходит recall (см. dialog.context.ts).
  ECOSYSTEM_SCRUTATOR_INTEGRATION: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
  // ARCA-0009 M5: MuneraAgent — Bearer JWT issued via Munera `POST /api/v1/auth/telegram`
  // (or Auth Arcana OIDC client_credentials after AUTH-* migration). Stored in Vault
  // `secret/munera/assistant-token`. Default flag enabled; tests/dev use stub token.
  MUNERA_BASE_URL: httpOrHttpsUrl,
  MUNERA_API_TOKEN: z.string().min(1, 'MUNERA_API_TOKEN required (Vault-managed JWT)'),
  MUNERA_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  ECOSYSTEM_MUNERA_INTEGRATION: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
  // ARCA-0009 session 4: default Munera project used by Telegram /task NL flow
  // (TaskHandler). When unset, TaskHandler replies with a configuration-error
  // notice and skips both approval and orchestrator dispatch. Per-user / per-
  // chat project mapping deferred to follow-up task.
  MUNERA_DEFAULT_PROJECT_ID: z.string().uuid().optional(),
  // ARCA-0009 M6: DreamerClient skeleton — feature-flagged OFF until AGENT-* server
  // migration lands (Operational Resilience Mandate Principle 2). When false, the
  // module registers but execute() returns `unavailable:dreamer_not_migrated`. When
  // true (post-migration via ARCA-* Phase 6b), live HTTP path activates.
  DREAMER_BASE_URL: z.string().url().optional(),
  DREAMER_API_TOKEN: z.string().min(1).optional(),
  DREAMER_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  ECOSYSTEM_DREAMER_LIVE: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),

  BRIEFING_TIMEZONE: z.string().min(1).default('Europe/Istanbul'),
  BRIEFING_MORNING_TIME: hhmm.default('08:00'),
  BRIEFING_EVENING_TIME: hhmm.default('21:00'),

  // ARCA-0009 M7 — hybrid inter-agent auth (V-AC-6).
  // MESH_VAULT_API_KEY: opaque `arc_api_*` key issued by Vault AppRole; required
  // for mesh peers to call assistant endpoints. Optional in dev (preflight
  // returns 401 when absent and no JWT/tailnet identity matches).
  MESH_VAULT_API_KEY: z.string().min(1).optional(),
  // MESH_AUTH_ARCANA_JWT: when 'true', AuthArcanaJwtStrategy becomes the
  // highest-priority gate (V-AC-6). Default 'false' — Vault API key path
  // remains active until AUTH-* phases ship.
  MESH_AUTH_ARCANA_JWT: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof configurationSchema>;

export function validateConfig(env: Record<string, unknown>): AppConfig {
  const result = configurationSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}
