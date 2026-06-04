import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { HttpHealthClient } from './http-health.client.js';

const BASE_URL = 'https://upstream.test.local';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('HttpHealthClient', () => {
  it('returns ok with version when /health responds {status:"ok",version}', async () => {
    server.use(
      http.get(`${BASE_URL}/health`, () => HttpResponse.json({ status: 'ok', version: '0.3.0' })),
    );
    const client = new HttpHealthClient({ baseUrl: BASE_URL });
    const result = await client.ping();
    expect(result.ok).toBe(true);
    expect(result.version).toBe('0.3.0');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('returns ok (no version) on a 2xx without a JSON body', async () => {
    server.use(http.get(`${BASE_URL}/health`, () => new HttpResponse('OK', { status: 200 })));
    const client = new HttpHealthClient({ baseUrl: BASE_URL });
    const result = await client.ping();
    expect(result.ok).toBe(true);
    expect(result.version).toBeUndefined();
  });

  it('returns ok=false when status field is not "ok"', async () => {
    server.use(http.get(`${BASE_URL}/health`, () => HttpResponse.json({ status: 'degraded' })));
    const client = new HttpHealthClient({ baseUrl: BASE_URL });
    const result = await client.ping();
    expect(result.ok).toBe(false);
  });

  it('returns ok=false with error on non-2xx', async () => {
    server.use(http.get(`${BASE_URL}/health`, () => new HttpResponse('nope', { status: 503 })));
    const client = new HttpHealthClient({ baseUrl: BASE_URL });
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HTTP 503');
  });

  it('returns ok=false with error when the request rejects (transport fault)', async () => {
    server.use(http.get(`${BASE_URL}/health`, () => HttpResponse.error()));
    const client = new HttpHealthClient({ baseUrl: BASE_URL });
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('sends no Authorization header when no bearerToken is configured', async () => {
    let seenAuth: string | null = 'unset';
    server.use(
      http.get(`${BASE_URL}/health`, ({ request }) => {
        seenAuth = request.headers.get('authorization');
        return HttpResponse.json({ status: 'ok' });
      }),
    );
    await new HttpHealthClient({ baseUrl: BASE_URL }).ping();
    expect(seenAuth).toBeNull();
  });

  it('sends a Bearer header when bearerToken is set', async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get(`${BASE_URL}/health`, ({ request }) => {
        seenAuth = request.headers.get('authorization');
        return HttpResponse.json({ status: 'ok' });
      }),
    );
    await new HttpHealthClient({ baseUrl: BASE_URL, bearerToken: 'tok123' }).ping();
    expect(seenAuth).toBe('Bearer tok123');
  });

  it('honours a custom healthPath', async () => {
    server.use(http.get(`${BASE_URL}/health/ready`, () => HttpResponse.json({ status: 'ok' })));
    const result = await new HttpHealthClient({
      baseUrl: BASE_URL,
      healthPath: '/health/ready',
    }).ping();
    expect(result.ok).toBe(true);
  });
});
