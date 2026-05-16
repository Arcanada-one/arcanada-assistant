import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AgentScopeError } from './exceptions.js';
import { ScopeGuard } from './scope-guard.js';
import { parseScopeManifest } from './scope.loader.js';
import type { ScopeManifest } from './scope.schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadDefaultManifest(): Promise<ScopeManifest> {
  const yamlPath = path.join(__dirname, 'agent-scopes.yaml');
  const raw = await readFile(yamlPath, 'utf8');
  return parseScopeManifest(raw);
}

describe('ScopeGuard', () => {
  it('allows known (principal, agent, intent) tuples from shipped manifest', async () => {
    const guard = new ScopeGuard();
    guard.load(await loadDefaultManifest());

    expect(guard.isAllowed('svc:assistant', 'transcriber', '/transcribe')).toBe(true);
    expect(guard.isAllowed('svc:assistant', 'munera', '/task_create')).toBe(true);
    expect(guard.isAllowed('svc:assistant', 'dreamer', '/dreamer/index_page')).toBe(true);
    expect(guard.isAllowed('svc:opsbot', 'ops-bot', '/opsbot/echo')).toBe(true);
  });

  it('denies (principal, agent, intent) tuples missing from manifest', async () => {
    const guard = new ScopeGuard();
    guard.load(await loadDefaultManifest());

    expect(guard.isAllowed('svc:assistant', 'munera', '/task_delete')).toBe(false);
    expect(guard.isAllowed('svc:opsbot', 'munera', '/task_create')).toBe(false);
    expect(guard.isAllowed('svc:unknown', 'transcriber', '/transcribe')).toBe(false);
  });

  it('assertAllowed throws AgentScopeError with principal + agent + intent metadata', async () => {
    const guard = new ScopeGuard();
    guard.load(await loadDefaultManifest());

    try {
      guard.assertAllowed('svc:opsbot', 'munera', '/task_create');
      throw new Error('expected AgentScopeError');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentScopeError);
      const scopeErr = err as AgentScopeError;
      expect(scopeErr.kind).toBe('scope');
      expect(scopeErr.principal).toBe('svc:opsbot');
      expect(scopeErr.agent).toBe('munera');
      expect(scopeErr.intent).toBe('/task_create');
    }
  });

  it('assertAllowed is silent for an allowed tuple', async () => {
    const guard = new ScopeGuard();
    guard.load(await loadDefaultManifest());
    expect(() => guard.assertAllowed('svc:assistant', 'knowledge', '/wiki')).not.toThrow();
  });

  it('reload swaps manifest atomically (old scopes purged)', () => {
    const guard = new ScopeGuard();
    guard.load({
      version: 1,
      scopes: [
        { principal: 'svc:a', agents: [{ name: 'x', intents: ['/foo'] }] },
      ],
    });
    expect(guard.isAllowed('svc:a', 'x', '/foo')).toBe(true);

    guard.load({
      version: 1,
      scopes: [
        { principal: 'svc:b', agents: [{ name: 'y', intents: ['/bar'] }] },
      ],
    });
    expect(guard.isAllowed('svc:a', 'x', '/foo')).toBe(false);
    expect(guard.isAllowed('svc:b', 'y', '/bar')).toBe(true);
  });

  it('listAgents / listIntents expose what a principal can reach', async () => {
    const guard = new ScopeGuard();
    guard.load(await loadDefaultManifest());

    const agents = guard.listAgents('svc:assistant').sort();
    expect(agents).toContain('transcriber');
    expect(agents).toContain('munera');
    expect(agents).toContain('knowledge');

    expect(guard.listIntents('svc:assistant', 'munera').sort()).toEqual([
      '/task_create',
      '/task_get',
      '/task_list',
      '/task_update',
    ]);
  });

  it('listAgents on unknown principal returns []', () => {
    const guard = new ScopeGuard();
    guard.load({
      version: 1,
      scopes: [{ principal: 'svc:a', agents: [{ name: 'x', intents: ['/foo'] }] }],
    });
    expect(guard.listAgents('svc:nobody')).toEqual([]);
    expect(guard.listIntents('svc:nobody', 'x')).toEqual([]);
  });
});
