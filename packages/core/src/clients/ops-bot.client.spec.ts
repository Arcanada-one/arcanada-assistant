import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import { OpsBotClient, OpsBotClientError } from './ops-bot.client.js';
import type { OpsBotLogger } from './ops-bot.client.js';
import { OpsBotWireEventSchema } from './ops-bot.types.js';

const BASE_URL = 'https://ops.test.local';
const API_KEY = 'test-api-key-1234';

interface ServerCallLog {
  authorization: string | null;
  lastEventBody: unknown;
  count: { events: number; metrics: number; health: number };
}

function makeServer(): { server: ReturnType<typeof setupServer>; calls: ServerCallLog } {
  const calls: ServerCallLog = {
    authorization: null,
    lastEventBody: null,
    count: { events: 0, metrics: 0, health: 0 },
  };
  const server = setupServer(
    http.post(`${BASE_URL}/events`, async ({ request }) => {
      calls.count.events += 1;
      calls.authorization = request.headers.get('authorization');
      calls.lastEventBody = await request.json();
      return HttpResponse.json(
        { event_id: '01J2H7K8FXYJ9P0Q3R5T6V8W0Z', status: 'accepted' },
        { status: 201 },
      );
    }),
    http.get(`${BASE_URL}/metrics`, () => {
      calls.count.metrics += 1;
      return new HttpResponse(
        '# HELP opsbot_agents_total agents\nopsbot_agents_total 7\n' +
          'opsbot_events_total{category="fatal"} 1\n' +
          'opsbot_events_total{category="info"} 41\n' +
          'opsbot_approvals_pending 2\n',
        { status: 200, headers: { 'content-type': 'text/plain; version=0.0.4' } },
      );
    }),
    http.get(`${BASE_URL}/health/ready`, () => {
      calls.count.health += 1;
      return HttpResponse.json({ ok: true });
    }),
  );
  return { server, calls };
}

const { server, calls } = makeServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  calls.authorization = null;
  calls.lastEventBody = null;
  calls.count.events = 0;
  calls.count.metrics = 0;
  calls.count.health = 0;
});
afterAll(() => server.close());

interface ClientOverrides {
  redis?: Redis;
  logger?: OpsBotLogger;
  resetTimeoutMs?: number;
  emitSelfHealOnRecovery?: boolean;
}

function makeClient(opts: ClientOverrides = {}): OpsBotClient {
  return new OpsBotClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    redis: opts.redis,
    logger: opts.logger,
    timeoutMs: 500,
    healthTimeoutMs: 200,
    cacheTtlMs: 60_000,
    retry: { maxAttempts: 2, baseDelayMs: 5 },
    emitSelfHealOnRecovery: opts.emitSelfHealOnRecovery ?? false,
    circuit: {
      volumeThreshold: 5,
      errorThresholdPercentage: 99,
      rollingCountTimeout: 30_000,
      resetTimeout: opts.resetTimeoutMs ?? 60_000,
    },
  });
}

describe('OpsBotClient.emitEvent', () => {
  it('POSTs /events with Bearer auth and parses ack', async () => {
    const client = makeClient();
    const ack = await client.emitEvent({
      service: 'arcanada-assistant',
      category: 'fatal',
      severity: 'fatal',
      message: 'ouch',
    });
    expect(ack.event_id).toBe('01J2H7K8FXYJ9P0Q3R5T6V8W0Z');
    expect(ack.status).toBe('accepted');
    expect(calls.authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls.count.events).toBe(1);
  });

  // ARCA-0122: the previous test only asserted the ack — it never checked
  // *what* was actually POSTed, which is exactly how the assistant/opsbot
  // schema drift (service/severity/context/audit_ref vs category/agent/
  // title/body/dedup_key) went unnoticed until a live PROD smoke. This
  // asserts the wire body against a mirror of opsbot's real CreateEventDto.
  it('POSTs a body matching Ops Bot CreateEventDto, not the internal OpsBotEventSchema shape', async () => {
    const client = makeClient();
    await client.emitEvent({
      service: 'arcanada-assistant',
      category: 'self_heal',
      severity: 'warning',
      message: 'proactive-dispatcher digest: 3 consecutive failures',
      context: { component: 'proactive-dispatcher', consecutive_failures: 3 },
    });
    expect(OpsBotWireEventSchema.safeParse(calls.lastEventBody).success).toBe(true);
    expect(calls.lastEventBody).toEqual({
      category: 'info',
      agent: 'arcanada-assistant',
      title: 'proactive-dispatcher digest: 3 consecutive failures',
      body: JSON.stringify({ component: 'proactive-dispatcher', consecutive_failures: 3 }),
    });
    // opsbot's DTO has no `service`/`severity`/`context`/`audit_ref`/`timestamp` fields
    expect(calls.lastEventBody).not.toHaveProperty('service');
    expect(calls.lastEventBody).not.toHaveProperty('severity');
    expect(calls.lastEventBody).not.toHaveProperty('timestamp');
  });

  it('rejects malformed input via Zod before HTTP', async () => {
    const client = makeClient();
    await expect(
      client.emitEvent({
        service: '',
        category: 'fatal',
        severity: 'fatal',
        message: 'm',
      }),
    ).rejects.toBeInstanceOf(OpsBotClientError);
    expect(calls.count.events).toBe(0);
  });

  it('throws OpsBotClientError for 4xx without retry', async () => {
    server.use(
      http.post(`${BASE_URL}/events`, () => HttpResponse.json({ error: 'bad' }, { status: 400 })),
    );
    const client = makeClient();
    await expect(
      client.emitEvent({
        service: 'arcanada-assistant',
        category: 'fatal',
        severity: 'fatal',
        message: 'ouch',
      }),
    ).rejects.toThrow(/HTTP 400/);
  });
});

describe('OpsBotClient circuit breaker', () => {
  const event = {
    service: 'arcanada-assistant',
    category: 'fatal' as const,
    severity: 'fatal' as const,
    message: 'm',
  };

  it('opens after configured volume of consecutive 5xx', async () => {
    server.use(
      http.post(`${BASE_URL}/events`, () => HttpResponse.json({ error: 'down' }, { status: 503 })),
    );
    const client = makeClient();
    for (let i = 0; i < 5; i += 1) {
      await expect(client.emitEvent(event)).rejects.toBeInstanceOf(OpsBotClientError);
    }
    expect(client.isCircuitOpen()).toBe(true);
    await expect(client.emitEvent(event)).rejects.toThrow(/circuit/i);
  });

  it('does NOT trip CB on 4xx (application errors excluded by errorFilter)', async () => {
    server.use(
      http.post(`${BASE_URL}/events`, () => HttpResponse.json({ error: 'bad' }, { status: 400 })),
    );
    const client = makeClient();
    for (let i = 0; i < 6; i += 1) {
      await expect(client.emitEvent(event)).rejects.toBeInstanceOf(OpsBotClientError);
    }
    expect(client.isCircuitOpen()).toBe(false);
  });

  it('does NOT trip CB on 401 (auth) or 404 (route gone)', async () => {
    let counter = 0;
    server.use(
      http.post(`${BASE_URL}/events`, () => {
        counter += 1;
        const status = counter % 2 === 0 ? 404 : 401;
        return HttpResponse.json({ error: 'x' }, { status });
      }),
    );
    const client = makeClient();
    for (let i = 0; i < 6; i += 1) {
      await expect(client.emitEvent(event)).rejects.toBeInstanceOf(OpsBotClientError);
    }
    expect(client.isCircuitOpen()).toBe(false);
  });

  it('DOES trip CB on 429 (downstream rate-limit signals load)', async () => {
    server.use(
      http.post(`${BASE_URL}/events`, () => HttpResponse.json({ error: 'rate' }, { status: 429 })),
    );
    const client = makeClient();
    for (let i = 0; i < 5; i += 1) {
      await expect(client.emitEvent(event)).rejects.toBeInstanceOf(OpsBotClientError);
    }
    expect(client.isCircuitOpen()).toBe(true);
  });

  it('emits self_heal event when CB transitions to close (recovery)', async () => {
    let failsLeft = 5;
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post(`${BASE_URL}/events`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        if (failsLeft > 0) {
          failsLeft -= 1;
          return HttpResponse.json({ error: 'down' }, { status: 503 });
        }
        return HttpResponse.json(
          { event_id: '01J2H7K8FXYJ9P0Q3R5T6V8W0Z', status: 'accepted' },
          { status: 201 },
        );
      }),
    );
    const client = makeClient({ resetTimeoutMs: 30, emitSelfHealOnRecovery: true });
    for (let i = 0; i < 5; i += 1) {
      await client.emitEvent(event).catch(() => undefined);
    }
    expect(client.isCircuitOpen()).toBe(true);
    await new Promise((r) => setTimeout(r, 80)); // > resetTimeoutMs (margin for CI)
    await client.emitEvent(event); // half-open → success → close
    await new Promise((r) => setTimeout(r, 100)); // let breaker.on('close') microtask flush
    // ARCA-0122: emitEvent now sends opsbot's wire shape (category/agent/
    // title/body), not the internal OpsBotEventSchema shape — self_heal maps
    // to wire category 'info', message -> title, context -> JSON body.
    const selfHeal = bodies.filter((b) => b.category === 'info');
    expect(selfHeal.length).toBeGreaterThanOrEqual(1);
    expect(selfHeal[0].title).toMatch(/recovered/);
    expect(JSON.parse(selfHeal[0].body as string)).toMatchObject({
      component: 'ops-bot-client',
      state: 'close',
    });
  });
});

describe('OpsBotClient.getEcosystemSnapshot', () => {
  it('parses Prometheus /metrics and returns snapshot', async () => {
    const client = makeClient();
    const snap = await client.getEcosystemSnapshot();
    expect(snap.agents_total).toBe(7);
    expect(snap.events_total).toBe(42);
    expect(snap.approvals_pending).toBe(2);
  });

  it('returns Redis-cached snapshot on second call within TTL', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const client = makeClient({ redis });
    const first = await client.getEcosystemSnapshot();
    const second = await client.getEcosystemSnapshot();
    expect(second).toEqual(first);
    expect(calls.count.metrics).toBe(1);
  });
});

describe('OpsBotClient.healthReady', () => {
  it('returns true on 200', async () => {
    const client = makeClient();
    await expect(client.healthReady()).resolves.toBe(true);
  });

  it('returns false on 5xx', async () => {
    server.use(
      http.get(`${BASE_URL}/health/ready`, () => HttpResponse.json({ ok: false }, { status: 500 })),
    );
    const client = makeClient();
    await expect(client.healthReady()).resolves.toBe(false);
  });

  it('returns false on timeout', async () => {
    server.use(
      http.get(`${BASE_URL}/health/ready`, async () => {
        await new Promise((r) => setTimeout(r, 400));
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = makeClient();
    await expect(client.healthReady()).resolves.toBe(false);
  });
});

describe('OpsBotClient.ping (ARCA-0127)', () => {
  it('returns ok with latency on a 2xx /health/ready', async () => {
    const client = makeClient();
    const result = await client.ping();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('surfaces version when /health/ready returns {status:"ok",version}', async () => {
    server.use(
      http.get(`${BASE_URL}/health/ready`, () =>
        HttpResponse.json({ status: 'ok', version: '1.2.3' }),
      ),
    );
    const client = makeClient();
    const result = await client.ping();
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.2.3');
  });

  it('returns ok=false with error on 5xx (never throws)', async () => {
    server.use(
      http.get(`${BASE_URL}/health/ready`, () =>
        HttpResponse.json({ status: 'fail' }, { status: 503 }),
      ),
    );
    const client = makeClient();
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns ok=false on timeout (never throws)', async () => {
    server.use(
      http.get(`${BASE_URL}/health/ready`, async () => {
        await new Promise((r) => setTimeout(r, 400));
        return HttpResponse.json({ status: 'ok' });
      }),
    );
    const client = makeClient();
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('OpsBotClient.executeCommand (ARCA-0009 M3, V-AC-3)', () => {
  const CMD_ID = '01J3K9Q2V4ZAB6X8Y0R2M5N7P9';
  const IDEMPOTENCY_KEY = '018f8e2a-1c2d-7000-9000-000000000001';

  function commandsServer(): {
    cmdCalls: { authorization: string | null; bodies: Record<string, unknown>[] };
  } {
    const cmdCalls = {
      authorization: null as string | null,
      bodies: [] as Record<string, unknown>[],
    };
    server.use(
      http.post(`${BASE_URL}/commands`, async ({ request }) => {
        cmdCalls.authorization = request.headers.get('authorization');
        const body = (await request.json()) as Record<string, unknown>;
        cmdCalls.bodies.push(body);
        return HttpResponse.json(
          {
            ok: true,
            command_id: CMD_ID,
            result: { echo: body.payload },
            executed_at: '2026-05-17T20:30:00.000Z',
          },
          { status: 201 },
        );
      }),
    );
    return { cmdCalls };
  }

  it('POSTs /commands with Bearer auth and parses ack', async () => {
    const { cmdCalls } = commandsServer();
    const client = makeClient();
    const ack = await client.executeCommand({
      cmd: 'echo-back',
      payload: { token: 'ARCA-0009' },
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(ack.ok).toBe(true);
    expect(ack.command_id).toBe(CMD_ID);
    expect(ack.result).toEqual({ echo: { token: 'ARCA-0009' } });
    expect(cmdCalls.authorization).toBe(`Bearer ${API_KEY}`);
    expect(cmdCalls.bodies[0]).toMatchObject({
      cmd: 'echo-back',
      payload: { token: 'ARCA-0009' },
      idempotency_key: IDEMPOTENCY_KEY,
    });
  });

  it('rejects malformed input via Zod before HTTP (closed enum + uuid guard)', async () => {
    const client = makeClient();
    await expect(
      client.executeCommand({
        // @ts-expect-error — invalid enum value, must fail at runtime via Zod
        cmd: 'unknown-cmd',
        payload: {},
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(OpsBotClientError);
    await expect(
      client.executeCommand({
        cmd: 'echo-back',
        payload: {},
        idempotencyKey: 'not-a-uuid',
      }),
    ).rejects.toBeInstanceOf(OpsBotClientError);
    expect(calls.count.events).toBe(0);
  });

  it('throws OpsBotClientError on 4xx without retry', async () => {
    server.use(
      http.post(`${BASE_URL}/commands`, () => HttpResponse.json({ error: 'bad' }, { status: 400 })),
    );
    const client = makeClient();
    await expect(
      client.executeCommand({
        cmd: 'echo-back',
        payload: {},
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toThrow(/HTTP 400/);
  });

  it('emits pre-execute + post-execute audit events (T4 control)', async () => {
    commandsServer();
    const client = makeClient();
    await client.executeCommand({
      cmd: 'echo-back',
      payload: { token: 'ARCA-0009' },
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    // Audit events go to /events (not /commands). The default server /events
    // handler in makeServer() increments calls.count.events — one for the
    // pre-execute envelope and one for the post-execute result envelope.
    expect(calls.count.events).toBe(2);
  });

  it('emits post-execute audit with ok=false when Ops Bot returns ok:false', async () => {
    server.use(
      http.post(`${BASE_URL}/commands`, () =>
        HttpResponse.json(
          {
            ok: false,
            command_id: CMD_ID,
            result: { reason: 'unsupported_command' },
            executed_at: '2026-05-17T20:31:00.000Z',
          },
          { status: 200 },
        ),
      ),
    );
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post(`${BASE_URL}/events`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return HttpResponse.json(
          { event_id: '01J2H7K8FXYJ9P0Q3R5T6V8W0Z', status: 'accepted' },
          { status: 201 },
        );
      }),
    );
    const client = makeClient();
    const ack = await client.executeCommand({
      cmd: 'echo-back',
      payload: {},
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(ack.ok).toBe(false);
    // ARCA-0122: wire shape uses title (not message) and JSON-string body (not context object)
    const post = bodies.find(
      (b) => typeof b.title === 'string' && (b.title as string).includes('result'),
    );
    expect(post).toBeDefined();
    expect((JSON.parse(post?.body as string) as Record<string, unknown>).ok).toBe(false);
  });

  it('does NOT retry on 5xx (executeCommand is non-idempotent at transport layer)', async () => {
    let calls5xx = 0;
    server.use(
      http.post(`${BASE_URL}/commands`, () => {
        calls5xx += 1;
        return HttpResponse.json({ error: 'down' }, { status: 503 });
      }),
    );
    const client = makeClient();
    await expect(
      client.executeCommand({
        cmd: 'echo-back',
        payload: {},
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(OpsBotClientError);
    expect(calls5xx).toBe(1);
  });

  it('rejects malformed Ops Bot response via Zod', async () => {
    server.use(
      http.post(`${BASE_URL}/commands`, () =>
        HttpResponse.json({ command_id: CMD_ID, executed_at: 'not-iso' }, { status: 201 }),
      ),
    );
    const client = makeClient();
    await expect(
      client.executeCommand({
        cmd: 'echo-back',
        payload: {},
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toThrow(/response/i);
  });
});

describe('OpsBotClient logger discipline', () => {
  it('never logs raw Authorization header', async () => {
    const logger: OpsBotLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    server.use(
      http.post(`${BASE_URL}/events`, () => HttpResponse.json({ error: 'x' }, { status: 500 })),
    );
    const client = makeClient({ logger });
    await client
      .emitEvent({
        service: 'arcanada-assistant',
        category: 'fatal',
        severity: 'fatal',
        message: 'm',
      })
      .catch(() => undefined);
    const all = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    const serialised = JSON.stringify(all);
    expect(serialised).not.toContain(API_KEY);
  });
});
