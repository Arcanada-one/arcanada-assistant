import { describe, expect, it } from 'vitest';

import type { MuneraTaskQuery } from '../agents/munera/munera.schemas.js';
import { UnconfiguredMuneraClient } from '../agents/munera/munera-unconfigured.client.js';

import {
  AGENT_KEY_FORBIDDEN_ENVELOPE,
  MUNERAL_BOARD,
  stubMuneraClient,
} from './__fixtures__/muneral-responses.js';
import { MuneralWorkItemsReader, referenceOf, zonedStartOfDay } from './muneral-reader.service.js';

const RUN_DATE = '2026-09-24';
const TZ = 'Europe/Istanbul';

function reader(client = stubMuneraClient()): MuneralWorkItemsReader {
  return new MuneralWorkItemsReader(client, { timeZone: TZ });
}

describe('MuneralWorkItemsReader', () => {
  describe('active work items', () => {
    it('reads the in_progress items and counts them', async () => {
      const result = await reader().readActiveTasks();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items.map((t) => t.id)).toEqual(['A2-281', 'A2-277']);
      expect(result.total).toBe(2);
      expect(result.truncated).toBe(false);
    });

    it('asks Muneral for in_progress rather than filtering a whole board in the caller', async () => {
      const calls: MuneraTaskQuery[] = [];
      await reader(stubMuneraClient({ calls })).readActiveTasks();
      expect(calls[0]?.status).toBe('in_progress');
    });
  });

  describe('backlog', () => {
    it('returns the top-N P0/P1 queued items, highest priority first', async () => {
      const result = await reader().readBacklogTopN(3);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // A2-261 is `critical` (P0), A2-260 is `high` (P1); the `low` row is out.
      expect(result.items.map((t) => t.id)).toEqual(['A2-261', 'A2-260']);
      expect(result.items.map((t) => t.priority)).toEqual(['P0', 'P1']);
    });

    it('translates the config P0/P1 spelling into Muneral priorities', async () => {
      const result = await reader().readBacklogTopN(5, ['P3']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items.map((t) => t.id)).toEqual(['0f1c4d8a']);
    });

    it('answers an empty list, not a refusal, when nothing is queued at those priorities', async () => {
      const result = await reader(stubMuneraClient({ board: [] })).readBacklogTopN(3);
      expect(result).toEqual({ ok: true, items: [], total: 0, truncated: false });
    });
  });

  describe('completed today', () => {
    it('counts only the items whose last move is inside the local day', async () => {
      const result = await reader().readCompletedToday(RUN_DATE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // A2-269 moved at 20:00Z on the 23rd — 23:00 local, the PREVIOUS day.
      expect(result.items.map((t) => t.id)).toEqual(['A2-276', 'A2-275']);
      expect(result.items.map((t) => t.id)).not.toContain('A2-269');
    });

    /**
     * MUTANT — drop the date filter.
     *
     * This is the failure the digest is meant to be incapable of: reporting
     * work that finished on another day as today's. The stub applies Muneral's
     * real `updatedSince`/`updatedBefore` semantics, so a reader that stops
     * sending them still gets a valid 200 — with yesterday's row in it.
     */
    it('goes red if the day bounds are not sent (mutant: no date filter)', async () => {
      const calls: MuneraTaskQuery[] = [];
      const mutant = stubMuneraClient({ calls });
      const original = mutant.queryTasks.bind(mutant);
      mutant.queryTasks = (query) => {
        const rest: MuneraTaskQuery = { ...query };
        delete rest.updatedSince;
        delete rest.updatedBefore;
        return original(rest);
      };
      const result = await new MuneralWorkItemsReader(mutant, { timeZone: TZ }).readCompletedToday(
        RUN_DATE,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items.map((t) => t.id)).toContain('A2-269');
      // …which is exactly what the unmutated reader must not do:
      const honest = await reader().readCompletedToday(RUN_DATE);
      expect(honest.ok && honest.items.map((t) => t.id)).not.toContain('A2-269');
    });

    it('sends the local-day bounds Muneral needs to do the filtering', async () => {
      const calls: MuneraTaskQuery[] = [];
      await reader(stubMuneraClient({ calls })).readCompletedToday(RUN_DATE);
      expect(calls[0]?.updatedSince).toBe('2026-09-23T21:00:00.000Z');
      expect(calls[0]?.updatedBefore).toBe('2026-09-24T21:00:00.000Z');
    });
  });

  describe('archived today', () => {
    it('reads Muneral status archived, not a Markdown archive directory', async () => {
      const result = await reader().readArchivedToday(RUN_DATE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items.map((t) => t.id)).toEqual(['A2-240']);
      expect(result.items[0]?.at).toBe('2026-09-24T09:00:00.000Z');
    });
  });

  describe('the fail-soft contract (ARCA-0154, kept)', () => {
    it('reports the HTTP status when Muneral refuses the read', async () => {
      const client = stubMuneraClient({
        unavailable: {
          kind: 'unavailable',
          reason: 'munera_forbidden',
          statusCode: AGENT_KEY_FORBIDDEN_ENVELOPE.statusCode,
          detail: AGENT_KEY_FORBIDDEN_ENVELOPE.message,
        },
      });
      const result = await reader(client).readActiveTasks();
      expect(result).toEqual({ ok: false, reason: 'HTTP 403' });
    });

    /**
     * MUTANT — swallow the refusal into an empty list.
     *
     * The shape of the result is what forbids this: `SourceResult` has no arm
     * that is both "the source did not answer" and "here are zero items", so a
     * 401/403 cannot be spelled as `[]` without a cast. The test pins the
     * distinction the renderer depends on.
     */
    it('never reports an unauthorised read as an empty board (mutant: 401 → [])', async () => {
      const client = stubMuneraClient({
        unavailable: { kind: 'unavailable', reason: 'munera_api_key_unauthorized', statusCode: 401 },
      });
      const result = await reader(client).readCompletedToday(RUN_DATE);
      expect(result.ok).toBe(false);
      expect(result).not.toEqual({ ok: true, items: [], total: 0, truncated: false });
      if (result.ok) return;
      expect(result.reason).toBe('HTTP 401');
    });

    it('names a missing key instead of an outage', async () => {
      const result = await new MuneralWorkItemsReader(new UnconfiguredMuneraClient(), {
        timeZone: TZ,
      }).readActiveTasks();
      expect(result).toEqual({ ok: false, reason: 'ключ не настроен (MUNERAL_AGENT_KEY_FILE)' });
    });

    it('treats a client with no credential at all the same way', async () => {
      const result = await new MuneralWorkItemsReader(null, { timeZone: TZ }).readActiveTasks();
      expect(result.ok).toBe(false);
    });

    it('marks a page that did not hold everything', async () => {
      const board = Array.from({ length: 205 }, (_, i) => ({
        ...MUNERAL_BOARD[0]!,
        id: `0f1c4d8a-1111-4aaa-9bbb-${String(i).padStart(12, '0')}`,
      }));
      const result = await reader(stubMuneraClient({ board })).readActiveTasks();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.items).toHaveLength(200);
      expect(result.total).toBe(205);
      expect(result.truncated).toBe(true);
    });
  });

  describe('references and day bounds', () => {
    it('lifts the human reference out of the title when it has one', () => {
      expect(referenceOf({ id: 'ffffffff-1111-2222-3333-444444444444', title: 'A2-281 — x' })).toBe(
        'A2-281',
      );
      expect(referenceOf({ id: 'ffffffff-1111-2222-3333-444444444444', title: 'без префикса' })).toBe(
        'ffffffff',
      );
    });

    it('computes midnight in the configured zone, not in UTC', () => {
      expect(zonedStartOfDay('2026-09-24', 'Europe/Istanbul').toISOString()).toBe(
        '2026-09-23T21:00:00.000Z',
      );
      expect(zonedStartOfDay('2026-09-24', 'UTC').toISOString()).toBe('2026-09-24T00:00:00.000Z');
    });

    it('handles a zone with DST across the boundary', () => {
      // 2026-03-29 is the European DST switch: midnight in Berlin is still +01:00.
      expect(zonedStartOfDay('2026-03-29', 'Europe/Berlin').toISOString()).toBe(
        '2026-03-28T23:00:00.000Z',
      );
      expect(zonedStartOfDay('2026-03-30', 'Europe/Berlin').toISOString()).toBe(
        '2026-03-29T22:00:00.000Z',
      );
    });
  });
});
