import { Injectable, Logger } from '@nestjs/common';

import type { IMuneraClient } from '../agents/munera/munera.client.js';
import { MUNERA_CREDENTIAL_NOT_CONFIGURED } from '../agents/munera/munera-unconfigured.client.js';
import type { MuneraTask, MuneraTaskQuery, TaskPageResult } from '../agents/munera/munera.schemas.js';

import type { ActiveTask, ArchivedItem, BacklogItem, CompletedTask } from './proactive.types.js';
import type { IWorkItemsReader, SourceResult } from './work-items.reader.js';

/** Muneral's `QueryTasksDto` caps a page at 200. Asking for more is a 400. */
const MAX_PAGE = 200;

/**
 * Muneral priorities, highest first. The Datarim `P0..P3` spelling the
 * briefing text uses is a RENDERING of these — there is no `P0` in Muneral, and
 * inventing one in the query would have filtered everything out.
 */
export const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
const PRIORITY_LABEL: Readonly<Record<string, string>> = {
  critical: 'P0',
  high: 'P1',
  medium: 'P2',
  low: 'P3',
};
/** What the briefing means by "top-N P0/P1". */
export const DEFAULT_BACKLOG_PRIORITIES = ['P0', 'P1'] as const;

export interface MuneralReaderOptions {
  /** Narrows every read to one project. Unset ⇒ every project the credential may see. */
  projectId?: string;
  /** IANA zone the run date is expressed in. Must match the proactive config. */
  timeZone?: string;
}

/**
 * A2-281 — the proactive briefing and digest read WORK ITEMS FROM MUNERAL.
 *
 * What they read before: Markdown under `DATARIM_PATH=/data/arcanada-kb/datarim`,
 * filled by an rsync from arcana-agents. INFRA-0417 decommissioned that host on
 * 2026-09-17; `/data/arcanada-kb` has been an empty directory ever since, so
 * every section of both messages rendered «⚠️ источник недоступен» every day.
 * Restoring the files was never the fix: work items live in Muneral and the
 * Markdown is a read-only historical source nobody writes to any more.
 *
 * ## The one route, and what it costs
 *
 * Every read here goes through `GET /api/v1/tasks` — Muneral's cross-project
 * filter, whose own DTO names this digest as the consumer it was built for.
 * The two alternatives were measured and rejected:
 *
 *   `GET /tasks/project/:id` answers an agent key with the tasks it is
 *   ASSIGNED to (`AgentTaskScopeGuard`, MUN-0043). The assistant is assigned
 *   nothing, so it would answer `[]` — a well-formed, authorised, completely
 *   empty board. That is the honest-looking «нет» this whole card exists to
 *   remove, and it is worse than the current failure because nothing about it
 *   looks wrong.
 *
 *   `GET /tasks/project/:id/index` answers ids, status, priority and a sha256
 *   of the title — no titles — and only to a key named in Muneral's
 *   `project-read-grants.ts`, per project, with a window that lapses.
 *
 * `GET /tasks` is not marked `@AgentScope(...)`, and an unmarked route refuses
 * an API key by default. Measured live from arcana-devs on 2026-09-24 with a
 * real `mun_sk_` key: `403 {"message":"This route is not available to an agent
 * API key… ask for the route to be scoped (MUN-0043)"}`. Until Muneral scopes
 * it, this reader renders «⚠️ Muneral недоступен: HTTP 403» — which is the
 * correct output for a source that refuses to answer, and is what the operator
 * needs to see to get the route scoped.
 *
 * ## "Today"
 *
 * Muneral's task row carries `updatedAt`, not a `doneAt`. "Completed today" is
 * therefore `status=done` AND `updatedAt` inside the run date's local day —
 * computed here as an instant pair and sent as `updatedSince`/`updatedBefore`,
 * so the filtering happens in the database, not in a caller that could forget
 * it. The proxy over-reports exactly one case: an item finished earlier whose
 * row was edited today (a title redaction). It under-reports none.
 */
@Injectable()
export class MuneralWorkItemsReader implements IWorkItemsReader {
  private readonly logger = new Logger(MuneralWorkItemsReader.name);
  private readonly projectId?: string;
  private readonly timeZone: string;

  constructor(
    private readonly client: IMuneraClient | null,
    options: MuneralReaderOptions = {},
  ) {
    if (options.projectId !== undefined) this.projectId = options.projectId;
    this.timeZone = options.timeZone ?? 'Europe/Istanbul';
  }

  async readActiveTasks(): Promise<SourceResult<ActiveTask>> {
    return this.read({ status: 'in_progress' }, (task) => ({
      id: referenceOf(task),
      title: task.title,
      priority: priorityLabel(task.priority),
      status: task.status,
    }));
  }

  /**
   * `priorities` is spelled in the briefing's `P0`/`P1` vocabulary because the
   * proactive config is. It is translated to Muneral's own words here; a label
   * nobody recognises is dropped with a warning rather than silently matching
   * nothing.
   */
  async readBacklogTopN(
    n: number,
    priorities: readonly string[] = DEFAULT_BACKLOG_PRIORITIES,
  ): Promise<SourceResult<BacklogItem>> {
    if (n <= 0) return { ok: true, items: [], total: 0, truncated: false };

    const wanted = new Set<string>();
    for (const label of priorities) {
      const muneral = PRIORITY_ORDER.find((p) => PRIORITY_LABEL[p] === label) ?? null;
      if (muneral) wanted.add(muneral);
      else this.logger.warn(`unknown backlog priority label ${label} — ignored`);
    }

    // Muneral's query filters by status but not by priority, and orders by
    // updatedAt. The priority pick therefore happens here, over the page — so
    // `truncated` matters: with more than MAX_PAGE queued items the top-N is a
    // top-N of what the page held, and the renderer says so.
    const page = await this.fetch({ status: 'todo' });
    if (!page.ok) return page;

    const matching = page.items
      .filter((t) => wanted.has(t.priority ?? ''))
      .sort(
        (a, b) =>
          PRIORITY_ORDER.indexOf((a.priority ?? 'low') as (typeof PRIORITY_ORDER)[number]) -
          PRIORITY_ORDER.indexOf((b.priority ?? 'low') as (typeof PRIORITY_ORDER)[number]),
      );

    return {
      ok: true,
      items: matching.slice(0, n).map((task) => ({
        id: referenceOf(task),
        title: task.title,
        priority: priorityLabel(task.priority),
      })),
      total: matching.length,
      truncated: page.truncated,
    };
  }

  async readCompletedToday(runDate: string): Promise<SourceResult<CompletedTask>> {
    return this.read({ status: 'done', ...this.dayBounds(runDate) }, (task) => ({
      id: referenceOf(task),
      title: task.title,
    }));
  }

  async readArchivedToday(runDate: string): Promise<SourceResult<ArchivedItem>> {
    return this.read({ status: 'archived', ...this.dayBounds(runDate) }, (task) => ({
      id: referenceOf(task),
      title: task.title,
      at: task.updatedAt,
    }));
  }

  private async read<T>(
    query: Omit<MuneraTaskQuery, 'projectId' | 'limit'>,
    map: (task: MuneraTask) => T,
  ): Promise<SourceResult<T>> {
    const page = await this.fetch(query);
    if (!page.ok) return page;
    return { ok: true, items: page.items.map(map), total: page.total, truncated: page.truncated };
  }

  private async fetch(
    query: Omit<MuneraTaskQuery, 'projectId' | 'limit'>,
  ): Promise<SourceResult<MuneraTask>> {
    if (!this.client) {
      return { ok: false, reason: 'ключ не настроен (MUNERAL_AGENT_KEY_FILE)' };
    }
    let result: TaskPageResult;
    try {
      result = await this.client.queryTasks({
        ...query,
        ...(this.projectId ? { projectId: this.projectId } : {}),
        limit: MAX_PAGE,
      });
    } catch (err) {
      // A malformed request throws rather than resolving `unavailable`. That is
      // our bug, not Muneral's, and it must still not read as an empty board.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`muneral query threw: ${message}`);
      return { ok: false, reason: 'ошибка запроса' };
    }
    if (result.kind === 'unavailable') {
      this.logger.warn(
        `muneral unavailable: reason=${result.reason} status=${result.statusCode ?? 'n/a'}`,
      );
      return { ok: false, reason: describeUnavailable(result) };
    }
    const { items, total } = result.page;
    return { ok: true, items, total, truncated: total > items.length };
  }

  /**
   * The instant pair that bounds `runDate` in the configured zone. Computed
   * from the zone's own offset at that moment rather than a hard-coded +03:00,
   * so a zone with DST (or a redeployment into one) does not move the boundary
   * by an hour and drop an evening's completions from the digest.
   */
  private dayBounds(runDate: string): { updatedSince: string; updatedBefore: string } {
    const start = zonedStartOfDay(runDate, this.timeZone);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { updatedSince: start.toISOString(), updatedBefore: end.toISOString() };
  }
}

/**
 * Muneral has no human key column: a task id is a UUID. Arcanada work items
 * carry their reference in the title (`A2-281 — …`), which is what the operator
 * recognises in a briefing, so it is lifted from there when present. When it is
 * not, the first segment of the UUID is shown — never a blank, and never a
 * guessed prefix.
 */
export function referenceOf(task: Pick<MuneraTask, 'id' | 'title'>): string {
  const m = /^\s*([A-Z][A-Z0-9]*-\d+)\b/.exec(task.title);
  return m?.[1] ?? task.id.slice(0, 8);
}

function priorityLabel(priority: string | null | undefined): string {
  return (priority && PRIORITY_LABEL[priority]) || 'P?';
}

/** The operator-facing cause. An HTTP status is the most useful thing we know. */
function describeUnavailable(
  result: Extract<TaskPageResult, { kind: 'unavailable' }>,
): string {
  if (result.reason === MUNERA_CREDENTIAL_NOT_CONFIGURED) {
    return 'ключ не настроен (MUNERAL_AGENT_KEY_FILE)';
  }
  if (result.statusCode !== undefined) return `HTTP ${result.statusCode}`;
  if (result.reason === 'munera_circuit_open') return 'circuit open';
  return result.reason;
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - at.getTime();
}

export function zonedStartOfDay(runDate: string, timeZone: string): Date {
  const naive = new Date(`${runDate}T00:00:00Z`);
  if (Number.isNaN(naive.getTime())) {
    throw new Error(`invalid runDate: ${runDate}`);
  }
  const firstGuess = new Date(naive.getTime() - zoneOffsetMs(naive, timeZone));
  // One correction pass: the offset that applies at the corrected instant may
  // differ from the offset at the guess across a DST boundary.
  return new Date(naive.getTime() - zoneOffsetMs(firstGuess, timeZone));
}
