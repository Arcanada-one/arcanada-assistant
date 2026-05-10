import { z } from 'zod';

/**
 * Scrutator API surface used by `arcanada-assistant` (4 routes):
 *   - GET  /health
 *   - POST /v1/search       — wiki semantic search (BGE-M3 hybrid)
 *   - POST /v1/ltm/ingest   — long-term memory write
 *   - POST /v1/ltm/recall   — long-term memory recall (RAG)
 *
 * Schemas mirror live OpenAPI capture in
 * `datarim/tasks/ARCA-0008-fixtures.md` § Schema shapes (probed 2026-05-10
 * against Scrutator v0.3.0 on `arcana-db:8310`). Field renames vs original
 * plan: `text` → `content`, `k` → `limit`, `hits` → `results`.
 */

// ── /v1/search ───────────────────────────────────────────────────────────────

export const SearchRequestSchema = z.object({
  query: z.string().min(1),
  namespace: z.string().optional(),
  project: z.string().optional(),
  source_type: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
  min_score: z.number().min(0).max(1).optional(),
  include_content: z.boolean().optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchHitSchema = z.object({
  chunk_id: z.string(),
  content: z.string(),
  source_path: z.string(),
  source_type: z.string().optional(),
  chunk_index: z.number().int().nonnegative().optional(),
  score: z.number(),
  namespace: z.string(),
  project: z.string().nullable().optional(),
  heading_hierarchy: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResultSchema = z.object({
  results: z.array(SearchHitSchema),
  total: z.number().int().nonnegative(),
  query: z.string(),
  search_time_ms: z.number().nonnegative(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

// ── /v1/ltm/ingest ───────────────────────────────────────────────────────────

export const IngestRequestSchema = z.object({
  content: z.string().min(1).max(8192),
  source_path: z.string().min(1),
  namespace: z.string().min(1).optional(),
  project: z.string().optional(),
});
export type IngestRequest = z.infer<typeof IngestRequestSchema>;

/**
 * Scrutator returns either a success body (with chunk_id-style ack) OR
 * a 200 + `{detail: "Ingest failed"}` envelope while the chunk still lands
 * in storage (observed in fixtures § Ingest reliability). The client
 * exposes both paths via `IngestResult.async`.
 */
export const IngestResultSchema = z.object({
  ok: z.boolean(),
  async: z.boolean(),
  warning: z.string().optional(),
  chunk_id: z.string().optional(),
});
export type IngestResult = z.infer<typeof IngestResultSchema>;

// ── /v1/ltm/recall ───────────────────────────────────────────────────────────

export const RecallRequestSchema = z.object({
  query: z.string().min(1),
  namespace: z.string().min(1).optional(),
  limit: z.number().int().positive().max(20).optional(),
  expand_entities: z.boolean().optional(),
  min_score: z.number().min(0).max(1).optional(),
});
export type RecallRequest = z.infer<typeof RecallRequestSchema>;

export const RecallHitSchema = z.object({
  chunk_id: z.string(),
  content: z.string(),
  source_path: z.string(),
  score: z.number(),
  namespace: z.string(),
  project: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  entities: z.array(z.unknown()).optional(),
  relations: z.array(z.unknown()).optional(),
});
export type RecallHit = z.infer<typeof RecallHitSchema>;

export const RecallResultSchema = z.object({
  results: z.array(RecallHitSchema),
  total: z.number().int().nonnegative(),
  query: z.string(),
  search_time_ms: z.number().nonnegative(),
});
export type RecallResult = z.infer<typeof RecallResultSchema>;

// ── /health ──────────────────────────────────────────────────────────────────

export const HealthResponseSchema = z.object({
  status: z.string(),
  service: z.string().optional(),
  version: z.string().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  version?: string;
  error?: string;
}
