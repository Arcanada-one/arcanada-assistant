import { z } from 'zod';

/**
 * agent-scopes.yaml schema v1 — closed set of principals + agent allow-lists.
 *
 * Each entry maps a principal (auth identity) to the agents and intents it
 * may invoke. `ScopeGuard` performs O(1) lookup; the manifest is loaded once
 * at boot and re-parsed only on explicit reload.
 */

const intentSchema = z
  .string()
  .min(1)
  .startsWith('/', { message: 'intent must start with /' });

const agentScopeEntrySchema = z.object({
  name: z.string().min(1),
  intents: z.array(intentSchema).min(1),
});

const principalScopeEntrySchema = z.object({
  principal: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_-]*$/i, {
      message: 'principal must match <namespace>:<identifier> (e.g. svc:assistant)',
    }),
  agents: z.array(agentScopeEntrySchema).min(1),
});

export const ScopeManifestSchema = z.object({
  version: z.literal(1),
  scopes: z.array(principalScopeEntrySchema).min(1),
});

export type ScopeManifest = z.infer<typeof ScopeManifestSchema>;
export type PrincipalScopeEntry = z.infer<typeof principalScopeEntrySchema>;
export type AgentScopeEntry = z.infer<typeof agentScopeEntrySchema>;
