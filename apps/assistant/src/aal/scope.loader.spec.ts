import { describe, expect, it } from 'vitest';

import { ScopeManifestLoadError, parseScopeManifest } from './scope.loader.js';

describe('parseScopeManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const yaml = `
version: 1
scopes:
  - principal: svc:assistant
    agents:
      - name: transcriber
        intents: ['/transcribe']
`;
    const parsed = parseScopeManifest(yaml);
    expect(parsed.version).toBe(1);
    expect(parsed.scopes).toHaveLength(1);
    expect(parsed.scopes[0].principal).toBe('svc:assistant');
  });

  it('rejects manifest with version other than 1', () => {
    const yaml = `
version: 2
scopes:
  - principal: svc:a
    agents: [{name: x, intents: ['/foo']}]
`;
    expect(() => parseScopeManifest(yaml)).toThrow(ScopeManifestLoadError);
  });

  it('rejects intent missing leading slash', () => {
    const yaml = `
version: 1
scopes:
  - principal: svc:a
    agents:
      - name: x
        intents: ['no-slash']
`;
    expect(() => parseScopeManifest(yaml)).toThrow(/must start with \//);
  });

  it('rejects malformed principal identifier', () => {
    const yaml = `
version: 1
scopes:
  - principal: nopecolon
    agents:
      - name: x
        intents: ['/foo']
`;
    expect(() => parseScopeManifest(yaml)).toThrow(/<namespace>:<identifier>/);
  });

  it('rejects empty intents list', () => {
    const yaml = `
version: 1
scopes:
  - principal: svc:a
    agents:
      - name: x
        intents: []
`;
    expect(() => parseScopeManifest(yaml)).toThrow(ScopeManifestLoadError);
  });

  it('rejects empty agents list', () => {
    const yaml = `
version: 1
scopes:
  - principal: svc:a
    agents: []
`;
    expect(() => parseScopeManifest(yaml)).toThrow(ScopeManifestLoadError);
  });

  it('rejects malformed YAML', () => {
    expect(() => parseScopeManifest('::: not yaml ::')).toThrow(ScopeManifestLoadError);
  });
});
