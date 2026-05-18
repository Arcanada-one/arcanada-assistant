import { z } from 'zod';

/**
 * Dreamer mesh agent — interface skeleton (M6, ARCA-0009).
 *
 * Live wiring is deferred to **ARCA-* Phase 6b** (gated by **AGENT-* Dreamer
 * server migration** per Operational Resilience Mandate Principle 2). Until
 * `ECOSYSTEM_DREAMER_LIVE=true`, the agent registers but every `execute()`
 * returns `unavailable: dreamer_not_migrated` — see
 * `dreamer-agent.service.ts`.
 *
 * Schemas below are derived from the Agent Dreamer PRD (`AGENT-0001`)
 * canonical intent surface: indexing a wiki page, summarising a paragraph
 * batch, generating cross-links. Field names may evolve once live HTTP
 * fixtures are captured per Internal HTTP Rule 1.
 */

export const DREAMER_INTENT_INDEX_PAGE = '/dreamer/index_page' as const;
export const DREAMER_INTENT_SUMMARIZE = '/dreamer/summarize' as const;
export const DREAMER_INTENT_LINK_GRAPH = '/dreamer/link_graph' as const;

export const IndexPageRequestSchema = z
  .object({
    pageId: z.string().min(1),
    title: z.string().min(1).max(500),
    contentMarkdown: z.string().min(1),
  })
  .strict();
export type IndexPageRequest = z.infer<typeof IndexPageRequestSchema>;

export const SummarizeRequestSchema = z
  .object({
    pageId: z.string().min(1),
    paragraphs: z.array(z.string().min(1)).min(1),
    maxTokens: z.number().int().positive().max(8192).default(512),
  })
  .strict();
export type SummarizeRequest = z.infer<typeof SummarizeRequestSchema>;

export const LinkGraphRequestSchema = z
  .object({
    rootPageId: z.string().min(1),
    depth: z.number().int().min(1).max(3).default(1),
  })
  .strict();
export type LinkGraphRequest = z.infer<typeof LinkGraphRequestSchema>;

export const IndexPageOkSchema = z.object({
  pageId: z.string().min(1),
  chunksIngested: z.number().int().nonnegative(),
  bytesProcessed: z.number().int().nonnegative(),
});
export type IndexPageOk = z.infer<typeof IndexPageOkSchema>;

export const SummarizeOkSchema = z.object({
  pageId: z.string().min(1),
  summary: z.string().min(1),
  tokensUsed: z.number().int().nonnegative(),
});
export type SummarizeOk = z.infer<typeof SummarizeOkSchema>;

export const LinkGraphOkSchema = z.object({
  rootPageId: z.string().min(1),
  nodes: z.array(z.object({ id: z.string(), title: z.string() })),
  edges: z.array(z.object({ source: z.string(), target: z.string() })),
});
export type LinkGraphOk = z.infer<typeof LinkGraphOkSchema>;

export const DreamerResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), payload: z.unknown() }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.string().min(1),
    detail: z.string().optional(),
  }),
]);
export type DreamerResult = z.infer<typeof DreamerResultSchema>;
