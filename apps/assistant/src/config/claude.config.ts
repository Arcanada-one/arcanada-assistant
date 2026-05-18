import { registerAs } from '@nestjs/config';
import { z } from 'zod';

// ARCA-0011 — Claude completion path via Model Connector.

const envSchema = z.object({
  MODEL_CONNECTOR_BASE_URL: z.string().url(),
  MODEL_CONNECTOR_API_KEY: z.string().min(1, 'MODEL_CONNECTOR_API_KEY required for Claude'),
  CLAUDE_DEFAULT_MODEL: z.string().min(1).default('anthropic/claude-sonnet-4'),
  CLAUDE_MC_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  CLAUDE_MAX_TOKENS: z.coerce.number().int().positive().max(64_000).optional(),
  CLAUDE_COST_WARN_USD: z.coerce.number().nonnegative().default(0.1),
  CLAUDE_VISION_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),
});

export interface ClaudeConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  timeoutMs: number;
  maxTokens?: number;
  costWarnUsd: number;
  visionEnabled: boolean;
}

export const CLAUDE_CONFIG = 'claude';

export default registerAs(CLAUDE_CONFIG, (): ClaudeConfig => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid Claude configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return {
    baseUrl: parsed.data.MODEL_CONNECTOR_BASE_URL,
    apiKey: parsed.data.MODEL_CONNECTOR_API_KEY,
    defaultModel: parsed.data.CLAUDE_DEFAULT_MODEL,
    timeoutMs: parsed.data.CLAUDE_MC_TIMEOUT_MS,
    ...(parsed.data.CLAUDE_MAX_TOKENS !== undefined
      ? { maxTokens: parsed.data.CLAUDE_MAX_TOKENS }
      : {}),
    costWarnUsd: parsed.data.CLAUDE_COST_WARN_USD,
    visionEnabled: parsed.data.CLAUDE_VISION_ENABLED,
  };
});
