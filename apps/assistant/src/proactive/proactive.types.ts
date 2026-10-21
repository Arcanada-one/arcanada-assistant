import { z } from 'zod';

/**
 * ARCA-0010 Proactive Communication — config schema (Vault YAML).
 * Source-of-truth: datarim/tasks/ARCA-0010-fixtures.md § 5.
 */
export const ProactiveConfigSchema = z.object({
  enabled: z.boolean().default(false),
  timezone: z.literal('Europe/Istanbul'),
  channels: z.object({
    briefing: z.object({
      enabled: z.boolean(),
      cron: z.string().min(1),
      chat_id: z.union([z.number().int(), z.string()]),
      include_active_tasks: z.boolean(),
      include_backlog_top_n: z.number().int().min(0).max(10),
      include_ecosystem_snapshot: z.boolean(),
      include_night_events_section: z.boolean(),
    }),
    digest: z.object({
      enabled: z.boolean(),
      cron: z.string().min(1),
      chat_id: z.union([z.number().int(), z.string()]),
      include_completed_tasks: z.boolean(),
      include_archived_items: z.boolean(),
      include_key_events: z.boolean(),
    }),
  }),
  dispatch: z.object({
    max_attempts: z.number().int().min(1).max(10),
    base_backoff_ms: z.number().int().min(100).max(60_000),
    self_heal_threshold: z.number().int().min(1).max(10),
    fallback_to_plain_text_on_md_error: z.boolean(),
  }),
  observability: z.object({
    pino_level: z.enum(['debug', 'info', 'warn', 'error']),
    prometheus_counter: z.string().min(1),
  }),
});

export type ProactiveConfig = z.infer<typeof ProactiveConfigSchema>;

export type ProactiveKind = 'briefing' | 'digest';

export type DispatchOutcome = 'sent' | 'skipped' | 'failed';

export interface DispatchResult {
  status: DispatchOutcome;
  reason?: string;
  messageId?: number;
}

export interface DispatchInput {
  kind: ProactiveKind;
  text: string;
  chatId: number | string;
  runDate: string;
}

export interface ComposedMessage {
  text: string;
  sections: string[];
}

/**
 * A2-281 — `complexity` (the Datarim `L<n>` level) has no counterpart in
 * Muneral and is gone from both work-item shapes rather than filled with a
 * plausible constant. `id`, when present, is the human reference carried by
 * the title. Muneral has no separate human sequence field, so no UUID fallback
 * is exposed.
 */
export interface ActiveTask {
  /** A title-carried human reference, when present. Never a UUID fallback. */
  id?: string;
  title: string;
  priority: string;
  status: string;
}

export interface BacklogItem {
  /** A title-carried human reference, when present. Never a UUID fallback. */
  id?: string;
  title: string;
  priority: string;
}

export interface CompletedTask {
  /** A title-carried human reference, when present. Never a UUID fallback. */
  id?: string;
  title: string;
}

/**
 * A2-281 — an item that reached Muneral status `archived`. It used to be a
 * `archive-<ID>.md` file under `documentation/archive/<subdir>/`, which is why
 * it carried `subdir` and the file's `mtime`. Muneral has no such file and no
 * such subdirectory: `archived` is a terminal status meaning the card left the
 * board unverified, and MUN-0043 is explicit that it is NOT a synonym for
 * `done`. So the section keeps its name and changes its source; `at` is the
 * instant of the last move, as Muneral reports it.
 */
export interface ArchivedItem {
  /** A title-carried human reference, when present. Never a UUID fallback. */
  id?: string;
  title: string;
  at: string;
}
