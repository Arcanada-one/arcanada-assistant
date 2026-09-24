import type { IMuneraClient } from '../../agents/munera/munera.client.js';
import type { MuneraTask, MuneraTaskQuery, TaskPageResult } from '../../agents/munera/munera.schemas.js';

/**
 * A2-281 — Muneral responses, and a stub that answers them the way the server
 * does.
 *
 * ## Provenance, stated exactly
 *
 * The two ERROR envelopes below were CAPTURED LIVE from arcana-devs against
 * `https://api.muneral.com/api/v1/tasks` on 2026-09-24, byte for byte, with a
 * real `mun_sk_` agent key. No credential appears here — only what the server
 * sent back.
 *
 * The task rows are SHAPE-DERIVED, not captured, and the difference is the
 * whole point of saying so: `GET /tasks` answers an agent key 403, so no 200
 * from that route could be captured with the credential this service will hold.
 * The shape is read off Muneral's own source — `TasksService.query` returns
 * `{items, total, limit, offset}`; the row columns and their spellings are
 * `model Task` in `apps/api/prisma/schema.prisma`. Titles and ids here are
 * invented. When the route is scoped (see the reader's header) this file should
 * be replaced with a real capture.
 */

/** Captured live 2026-09-24: `GET /api/v1/tasks?limit=2`, `Authorization: Bearer mun_sk_…`. */
export const AGENT_KEY_FORBIDDEN_ENVELOPE = {
  message:
    'This route is not available to an agent API key. Authenticate as a user, or ask for the route to be scoped (MUN-0043).',
  error: 'Forbidden',
  statusCode: 403,
} as const;

/** Captured live 2026-09-24: same route, key sent on `X-API-Key` (Muneral reads `Authorization` only). */
export const UNAUTHORIZED_ENVELOPE = {
  message: 'Unauthorized',
  statusCode: 401,
} as const;

const PROJECT = '08a50f9a-a735-4605-91ce-ce4a41193fbb';

function row(
  id: string,
  title: string,
  status: MuneraTask['status'],
  priority: MuneraTask['priority'],
  updatedAt: string,
): MuneraTask {
  return {
    id,
    projectId: PROJECT,
    title,
    description: null,
    status,
    priority,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt,
  };
}

/**
 * The board this suite reasons about. Times are UTC; the run date used in the
 * tests is 2026-09-24 in Europe/Istanbul (UTC+3), so the local day is
 * 2026-09-23T21:00Z … 2026-09-24T21:00Z — which is why the two rows at 21:30Z
 * and 20:00Z on the 23rd sit on OPPOSITE sides of the boundary.
 */
export const MUNERAL_BOARD: readonly MuneraTask[] = [
  row('0f1c4d8a-1111-4aaa-9bbb-000000000001', 'A2-281 — брифинг читает Muneral', 'in_progress', 'critical', '2026-09-24T06:10:00.000Z'),
  row('0f1c4d8a-1111-4aaa-9bbb-000000000002', 'A2-277 — ключи агентов в файлах', 'in_progress', 'high', '2026-09-24T05:00:00.000Z'),
  row('0f1c4d8a-1111-4aaa-9bbb-000000000003', 'A2-260 — вычистить rsync-остатки', 'todo', 'high', '2026-09-22T11:00:00.000Z'),
  row('0f1c4d8a-1111-4aaa-9bbb-000000000004', 'A2-261 — переписать runbook', 'todo', 'critical', '2026-09-21T08:30:00.000Z'),
  row('0f1c4d8a-1111-4aaa-9bbb-000000000005', 'Мелкая правка без префикса', 'todo', 'low', '2026-09-20T08:30:00.000Z'),
  // Done INSIDE the Istanbul day of 2026-09-24 (23rd 21:30Z is already the 24th locally).
  row('0f1c4d8a-1111-4aaa-9bbb-000000000006', 'A2-276 — ARAS читает расписки', 'done', 'high', '2026-09-23T21:30:00.000Z'),
  row('0f1c4d8a-1111-4aaa-9bbb-000000000007', 'A2-275 — расписка допуска', 'done', 'medium', '2026-09-24T15:00:00.000Z'),
  // Done BEFORE that day started (20:00Z on the 23rd is 23:00 local on the 23rd).
  row('0f1c4d8a-1111-4aaa-9bbb-000000000008', 'A2-269 — контур из одиннадцати проектов', 'done', 'high', '2026-09-23T20:00:00.000Z'),
  row('0f1c4d8a-1111-4aaa-9bbb-000000000009', 'A2-240 — карточка снята с доски', 'archived', 'low', '2026-09-24T09:00:00.000Z'),
];

export interface StubOptions {
  board?: readonly MuneraTask[];
  /** Answer every call with this instead of a page. */
  unavailable?: Extract<TaskPageResult, { kind: 'unavailable' }>;
  /** Records every query the reader sent, in order. */
  calls?: MuneraTaskQuery[];
}

/**
 * A stub that applies Muneral's OWN filter semantics — `TasksService.query`:
 * `status` exact, `updatedAt >= updatedSince`, `updatedAt < updatedBefore`,
 * `total` counted before paging.
 *
 * It filters rather than echoing a canned list ON PURPOSE. A reader that stops
 * sending `updatedSince` still gets a well-formed 200 out of this stub — and
 * yesterday's completions come back in it, which is what makes the missing
 * filter fail a test instead of passing one.
 */
export function stubMuneraClient(opts: StubOptions = {}): IMuneraClient {
  const board = opts.board ?? MUNERAL_BOARD;
  const client: Partial<IMuneraClient> = {
    isCircuitOpen: () => false,
    queryTasks: (query: MuneraTaskQuery) => {
      opts.calls?.push(query);
      if (opts.unavailable) return Promise.resolve(opts.unavailable);
      const matched = board.filter((t) => {
        if (query.status !== undefined && t.status !== query.status) return false;
        if (query.projectId !== undefined && t.projectId !== query.projectId) return false;
        if (query.updatedSince !== undefined && Date.parse(t.updatedAt) < Date.parse(query.updatedSince)) {
          return false;
        }
        if (query.updatedBefore !== undefined && Date.parse(t.updatedAt) >= Date.parse(query.updatedBefore)) {
          return false;
        }
        return true;
      });
      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      return Promise.resolve({
        kind: 'ok',
        page: { items: matched.slice(offset, offset + limit), total: matched.length, limit, offset },
      });
    },
  };
  return client as IMuneraClient;
}
