import { describe, it, expect, vi } from 'vitest';

import {
  EmergencyDigestPageSchema,
  EMERGENCY_DIGEST_TITLE,
  EMERGENCY_DIGEST_NOTICE,
  TaskPageResultSchema,
  type TaskPageResult,
} from '../agents/munera/munera.schemas.js';
import { MuneraClient } from '../agents/munera/munera.client.js';

import { stubMuneraClient } from './__fixtures__/muneral-responses.js';
import { baseProactiveConfig } from './__fixtures__/proactive-config.fixture.js';
import { MuneralWorkItemsReader } from './muneral-reader.service.js';
import { BriefingAggregator } from './briefing.aggregator.js';
import { DigestAggregator } from './digest.aggregator.js';

const until = '2099-01-01T00:00:00Z';
function page() {
  return {
    items: [],
    total: 0,
    limit: 200,
    offset: 0,
    disclosure: {
      mode: 'metadata_only',
      withheld: ['title', 'description'],
      notice: EMERGENCY_DIGEST_NOTICE,
    },
    grant: { decision: 'DEC-AUP-0049', until },
    counted: "every task of the key's own workspace matching the filters, before paging",
    generatedAt: '2026-10-10T19:00:00Z',
    auditEventId: '11111111-2222-4333-8444-555555555555',
  };
}
function reader(value: unknown) {
  const client = stubMuneraClient();
  client.queryWorkspaceDigest = async () => TaskPageResultSchema.parse(value);
  return new MuneralWorkItemsReader(client, { timeZone: 'UTC' });
}
function plain(text: string) {
  return text.replaceAll('\\', '');
}
const input = { runDate: '2026-10-10', config: baseProactiveConfig };
describe('Emergency metadata boundary', () => {
  it('validates exact projection and literal; refuses private/invalid metadata', () => {
    const item = {
      id: '11111111-2222-4333-8444-555555555555',
      projectId: '11111111-2222-4333-8444-555555555556',
      title: EMERGENCY_DIGEST_TITLE,
      status: 'todo',
      priority: 'high',
      createdAt: '2026-10-10T19:00:00Z',
      updatedAt: '2026-10-10T19:00:00Z',
    };
    expect(
      EmergencyDigestPageSchema.safeParse({ ...page(), items: [item], total: 1 }).success,
    ).toBe(true);
    for (const mutation of [
      { title: 'PRIVATE_INVALID_VALUE' },
      { id: 'PRIVATE_INVALID_VALUE' },
      { projectId: 'PRIVATE_INVALID_VALUE' },
      { priority: 'PRIVATE_INVALID_VALUE' },
      { status: 'PRIVATE_INVALID_VALUE' },
      { description: 'PRIVATE_INVALID_VALUE' },
      { createdAt: 'PRIVATE_INVALID_VALUE' },
    ])
      expect(
        EmergencyDigestPageSchema.safeParse({
          ...page(),
          items: [{ ...item, ...mutation }],
          total: 1,
        }).success,
      ).toBe(false);
  });
  it.each([
    undefined,
    { mode: 'unknown' },
    { mode: 'metadata_only' },
    { ...page().disclosure, notice: 'PRIVATE_INVALID_VALUE' },
  ])('refuses altered disclosure without reflecting values', async (disclosure) => {
    const out = await reader({ kind: 'ok', page: { ...page(), disclosure } }).readActiveTasks();
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain('PRIVATE_INVALID_VALUE');
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid counter %s', async (total) => {
    expect((await reader({ kind: 'ok', page: { ...page(), total } }).readActiveTasks()).ok).toBe(
      false,
    );
  });
  it('refuses expired HTTP success', async () => {
    expect(
      (
        await reader({
          kind: 'ok',
          page: { ...page(), grant: { decision: 'DEC-AUP-0049', until: '2026-10-09T00:00:00Z' } },
        }).readActiveTasks()
      ).ok,
    ).toBe(false);
  });
  it('empty success has disclosure/expiry in all five work-item sections', async () => {
    const r = reader({ kind: 'ok', page: page() });
    const b = plain(
      (
        await new BriefingAggregator({} as never, r).compose({
          ...input,
          config: {
            ...input.config,
            channels: {
              ...input.config.channels,
              briefing: { ...input.config.channels.briefing, include_ecosystem_snapshot: false },
            },
          },
        })
      ).text,
    );
    const d = plain((await new DigestAggregator(r).compose(input)).text);
    expect(b.split(EMERGENCY_DIGEST_NOTICE)).toHaveLength(3);
    expect(d.split(EMERGENCY_DIGEST_NOTICE)).toHaveLength(4);
    expect(b.split(until)).toHaveLength(3);
    expect(d.split(until)).toHaveLength(4);
    expect(b).toContain('нет');
    expect(d).toContain('нет');
  });
  it.each([
    { kind: 'unavailable', reason: 'refused', statusCode: 403 },
    { kind: 'unavailable', reason: 'outage', statusCode: 503 },
    { kind: 'unavailable', reason: 'network' },
  ])('refused/outage sections never claim successful metadata disclosure/empty', async (value) => {
    const d = plain((await new DigestAggregator(reader(value)).compose(input)).text);
    expect(d).not.toContain(EMERGENCY_DIGEST_NOTICE);
    expect(d).not.toContain(until);
    expect(d).not.toContain('— нет');
  });
  it('real malformed HTTP200 becomes explicit metadata refusal in all five sections', async () => {
    const client = new MuneraClient({
      baseUrl: 'http://127.0.0.1:1/api/v1',
      apiToken: 'mun_sk_synthetic',
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ...page(),
        items: [{ id: '11111111-2222-4333-8444-555555555555',
          projectId: '11111111-2222-4333-8444-555555555556',
          title: 'SYNTHETIC_PRIVATE_POISON', status: 'todo', priority: 'high',
          createdAt: '2026-10-10T19:00:00Z', updatedAt: '2026-10-10T19:00:00Z' }],
        total: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    });
    const r = new MuneralWorkItemsReader(client, { timeZone: 'UTC' });
    const b = plain((await new BriefingAggregator({} as never, r).compose({
      ...input, config: { ...input.config, channels: { ...input.config.channels,
        briefing: { ...input.config.channels.briefing, include_ecosystem_snapshot: false } } },
    })).text);
    const d = plain((await new DigestAggregator(r).compose(input)).text);
    expect(b.split('DIGEST_METADATA_REFUSED')).toHaveLength(3);
    expect(d.split('DIGEST_METADATA_REFUSED')).toHaveLength(4);
    for (const text of [b, d]) {
      expect(text).toContain('Это НЕ пустой список');
      expect(text).not.toContain('SYNTHETIC_PRIVATE_POISON');
      expect(text).not.toContain(EMERGENCY_DIGEST_NOTICE);
      expect(text).not.toContain('HTTP 200');
      expect(text).not.toContain('— нет');
      expect(text).not.toContain('— пусто');
    }
  });
  it('concurrent success/refusal/other-expiry reads keep result custody', async () => {
    const pending: ((p: TaskPageResult) => void)[] = [];
    const client = stubMuneraClient();
    client.queryWorkspaceDigest = () =>
      new Promise<TaskPageResult>((resolve) => pending.push(resolve));
    const r = new MuneralWorkItemsReader(client, { timeZone: 'UTC' });
    const active = r.readActiveTasks(),
      done = r.readCompletedToday('2026-10-10'),
      archive = r.readArchivedToday('2026-10-10');
    pending[1]!({ kind: 'unavailable', reason: 'refused', statusCode: 403 });
    pending[2]!({
      kind: 'ok',
      page: { ...page(), grant: { decision: 'DEC-AUP-0049', until: '2099-02-01T00:00:00Z' } },
    });
    pending[0]!({ kind: 'ok', page: page() });
    const [a, d, h] = await Promise.all([active, done, archive]);
    expect(a.ok && a.disclosure?.until).toBe(until);
    expect(d.ok).toBe(false);
    expect(h.ok && h.disclosure?.until).toBe('2099-02-01T00:00:00Z');
  });
  it.each([
    {
      status: 403,
      body: {
        code: 'GRANT_EXPIRED',
        scope: 'workspace-digest',
        workspaceId: '11111111-2222-4333-8444-555555555555',
        message: 'PRIVATE_ERROR_VALUE',
        until: 'PRIVATE_ERROR_VALUE',
        decision: 'DEC-AUP-0049',
      },
    },
    {
      status: 403,
      body: {
        code: 'GRANT_EXPIRED',
        scope: 'workspace-digest',
        workspaceId: '11111111-2222-4333-8444-555555555555',
        message: 'PRIVATE_ERROR_VALUE',
        until: '2026-10-09T00:00:00Z',
        decision: 'PRIVATE_ERROR_VALUE',
      },
    },
    { status: 503, body: { message: 'PRIVATE_ERROR_VALUE' } },
    { status: 401, body: { message: 'PRIVATE_ERROR_VALUE' } },
  ])(
    'real emergency client/reader never reflects untrusted error body',
    async ({ status, body }) => {
      const logs: unknown[] = [];
      const logger = {
        info: (x: unknown) => logs.push(x),
        warn: (x: unknown) => logs.push(x),
        error: (x: unknown) => logs.push(x),
      };
      const client = new MuneraClient({
        baseUrl: 'http://127.0.0.1:1/api/v1',
        apiToken: 'mun_sk_synthetic',
        retry: { maxAttempts: 0, baseDelayMs: 0 },
        logger,
        fetchImpl: vi.fn(
          async () =>
            new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      });
      const result = await client.queryWorkspaceDigest({});
      expect(result.kind).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain('PRIVATE_ERROR_VALUE');
      expect(JSON.stringify(logs)).not.toContain('PRIVATE_ERROR_VALUE');
      const out = await new MuneralWorkItemsReader(client, { timeZone: 'UTC' }).readActiveTasks();
      expect(out.ok).toBe(false);
      expect(JSON.stringify(out)).not.toContain('PRIVATE_ERROR_VALUE');
    },
  );
  it.each([
    { grant: { ...page().grant, decision: 'SYNTHETIC_PRIVATE_MARKER' } },
    { counted: 'SYNTHETIC_PRIVATE_MARKER' },
  ])('refuses unsafe success policy/count text before reader logging', async (mutation) => {
    const r = reader({ kind: 'ok', page: { ...page(), ...mutation } });
    const loggerSpy = vi.spyOn(
      (r as unknown as { logger: { warn: () => void; log: () => void } }).logger,
      'log',
    );
    const out = await r.readActiveTasks();
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(loggerSpy).not.toHaveBeenCalled();
  });
});
