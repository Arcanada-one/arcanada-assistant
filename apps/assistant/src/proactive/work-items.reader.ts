import type { ActiveTask, ArchivedItem, BacklogItem, CompletedTask } from './proactive.types.js';

/**
 * A2-281 — the contract the proactive briefing and digest read work items
 * through.
 *
 * It replaces `IDatarimReader`, whose shape was the defect. That interface
 * answered `T[]` and offered a separate `sourceAvailable()` probe, so every
 * failure a reader hit between the probe and the read — a 401, a 403, a parse
 * error, a timeout — came back as `[]` and rendered as an honest-looking
 * «нет». ARCA-0154 patched the worst case (an unmounted directory) by probing
 * first; it could not patch the general one, because the return type has no
 * room for "not measured".
 *
 * Here every read answers one of two things and the renderer must handle both:
 *
 *   `{ ok: true, items, total, truncated }` — the source answered. `items` may
 *   be empty, and THAT is the honest «нет». `total` is what the source counted
 *   before paging, so a caller can say 12 and show 3; `truncated` says the page
 *   did not hold everything that matched.
 *
 *   `{ ok: false, reason }` — the source did not answer. `reason` names the
 *   cause in the text the operator reads (`HTTP 403`, `ключ не настроен`), so a
 *   broken briefing says what to fix instead of claiming an empty board.
 */
export interface SourceOk<T> {
  ok: true;
  items: readonly T[];
  /** What the source counted before paging. Equals `items.length` when the page held everything. */
  total: number;
  /** True when `total` exceeds what this page could carry, so `items` is a prefix. */
  truncated: boolean;
}

export interface SourceUnavailable {
  ok: false;
  /** Operator-facing cause, e.g. `HTTP 403` or `ключ не настроен`. Never empty. */
  reason: string;
}

export type SourceResult<T> = SourceOk<T> | SourceUnavailable;

export interface IWorkItemsReader {
  /** Work items currently `in_progress`. */
  readActiveTasks(): Promise<SourceResult<ActiveTask>>;
  /** Up to `n` queued (`todo`) items at the given priorities, highest first. */
  readBacklogTopN(n: number, priorities?: readonly string[]): Promise<SourceResult<BacklogItem>>;
  /** Items whose status is `done` and whose last move falls inside `runDate` (configured timezone). */
  readCompletedToday(runDate: string): Promise<SourceResult<CompletedTask>>;
  /** Items whose status is `archived` and whose last move falls inside `runDate`. */
  readArchivedToday(runDate: string): Promise<SourceResult<ArchivedItem>>;
}

export const WORK_ITEMS_READER = Symbol.for('WORK_ITEMS_READER');
