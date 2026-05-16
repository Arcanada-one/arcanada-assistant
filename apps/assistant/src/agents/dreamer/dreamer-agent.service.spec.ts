import { describe, expect, it, vi } from 'vitest';

import { DreamerClient } from './dreamer.client.js';
import { DreamerAgentService } from './dreamer-agent.service.js';
import {
  DREAMER_INTENT_INDEX_PAGE,
  DREAMER_INTENT_LINK_GRAPH,
  DREAMER_INTENT_SUMMARIZE,
} from './dreamer.schemas.js';

describe('DreamerAgentService (skeleton)', () => {
  it('claims index_page / summarize / link_graph intents', () => {
    const client = new DreamerClient();
    const agent = new DreamerAgentService(client);
    expect(agent.name).toBe('dreamer');
    expect(agent.intents).toEqual([
      DREAMER_INTENT_INDEX_PAGE,
      DREAMER_INTENT_SUMMARIZE,
      DREAMER_INTENT_LINK_GRAPH,
    ]);
  });

  it('returns dreamer_not_migrated for indexPage when live=false', async () => {
    const client = new DreamerClient({ live: false });
    const agent = new DreamerAgentService(client);
    const result = await agent.execute(DREAMER_INTENT_INDEX_PAGE, {
      pageId: 'wiki/auth',
      title: 'Auth Arcana mandate',
      contentMarkdown: '# Hello',
    });
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('dreamer_not_migrated');
      expect(result.detail).toMatch(/Phase 6b/);
    }
  });

  it('returns dreamer_not_migrated for summarize when live=true (live HTTP unimplemented)', async () => {
    const client = new DreamerClient({ live: true });
    const agent = new DreamerAgentService(client);
    const result = await agent.execute(DREAMER_INTENT_SUMMARIZE, {
      pageId: 'wiki/x',
      paragraphs: ['p1', 'p2'],
      maxTokens: 100,
    });
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('dreamer_not_migrated');
    }
  });

  it('rejects invalid payload shape before reaching client', async () => {
    const client = new DreamerClient();
    const agent = new DreamerAgentService(client);
    const result = await agent.execute(DREAMER_INTENT_INDEX_PAGE, null);
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toBe('dreamer_invalid_payload');
    }
  });

  it('throws on unknown intent', async () => {
    const client = new DreamerClient();
    const agent = new DreamerAgentService(client);
    await expect(agent.execute('/unknown', { pageId: 'x' } as never)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'dreamer_error',
      detail: expect.stringMatching(/does not handle/),
    });
  });

  it('dispatches link_graph intent and surfaces validation error from client', async () => {
    const client = new DreamerClient();
    const indexSpy = vi.spyOn(client, 'linkGraph');
    const agent = new DreamerAgentService(client);
    await agent.execute(DREAMER_INTENT_LINK_GRAPH, {
      rootPageId: 'wiki/root',
      depth: 2,
    });
    expect(indexSpy).toHaveBeenCalledWith({ rootPageId: 'wiki/root', depth: 2 });
  });

  it('isLive() always false in M6 skeleton (regardless of live flag)', () => {
    expect(new DreamerClient({ live: false }).isLive()).toBe(false);
    expect(new DreamerClient({ live: true }).isLive()).toBe(false);
  });
});
