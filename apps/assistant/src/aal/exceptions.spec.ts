import { describe, expect, it } from 'vitest';

import {
  AgentAuthError,
  AgentError,
  AgentScopeError,
  AgentSoftFailError,
  AgentTimeoutError,
  AgentValidationError,
  classifyAgentError,
  isAgentError,
} from './exceptions.js';

describe('AAL exception hierarchy', () => {
  it('every subclass inherits from AgentError and from Error', () => {
    const cases: AgentError[] = [
      new AgentAuthError('no creds'),
      new AgentTimeoutError('slow', { timeoutMs: 1000 }),
      new AgentSoftFailError('cb open', { reason: 'circuit_open' }),
      new AgentValidationError('bad input', { issues: [{ path: 'audio', message: 'required' }] }),
      new AgentScopeError('not allowed', { principal: 'svc:assistant' }),
    ];
    for (const err of cases) {
      expect(err).toBeInstanceOf(AgentError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('kind discriminator is stable per subclass', () => {
    expect(new AgentAuthError('x').kind).toBe('auth');
    expect(new AgentTimeoutError('x').kind).toBe('timeout');
    expect(new AgentSoftFailError('x').kind).toBe('soft_fail');
    expect(new AgentValidationError('x').kind).toBe('validation');
    expect(new AgentScopeError('x').kind).toBe('scope');
  });

  it('preserves agent / intent / cause / detail on construction', () => {
    const cause = new Error('underlying');
    const err = new AgentTimeoutError('agent slow', {
      agent: 'transcriber',
      intent: '/transcribe',
      cause,
      detail: 'after 30s',
      timeoutMs: 30_000,
    });
    expect(err.agent).toBe('transcriber');
    expect(err.intent).toBe('/transcribe');
    expect(err.cause).toBe(cause);
    expect(err.detail).toBe('after 30s');
    expect(err.timeoutMs).toBe(30_000);
  });

  it('AgentValidationError carries structured issues', () => {
    const err = new AgentValidationError('zod failed', {
      issues: [
        { path: 'audio', message: 'must be Buffer' },
        { path: 'mimeType', message: 'unsupported' },
      ],
    });
    expect(err.issues).toEqual([
      { path: 'audio', message: 'must be Buffer' },
      { path: 'mimeType', message: 'unsupported' },
    ]);
  });

  it('AgentScopeError records principal', () => {
    const err = new AgentScopeError('intent not in scope', { principal: 'svc:munera' });
    expect(err.principal).toBe('svc:munera');
  });

  it('classifyAgentError returns the same instance for known subclasses', () => {
    const err = new AgentAuthError('no key');
    expect(classifyAgentError(err)).toBe(err);
  });

  it('classifyAgentError returns undefined for non-AgentError throwables', () => {
    expect(classifyAgentError(new Error('random'))).toBeUndefined();
    expect(classifyAgentError(new TypeError('bad'))).toBeUndefined();
    expect(classifyAgentError('string thrown')).toBeUndefined();
    expect(classifyAgentError(undefined)).toBeUndefined();
  });

  it('isAgentError narrows the type', () => {
    const e: unknown = new AgentScopeError('x');
    if (isAgentError(e)) {
      // type-narrowed access
      expect(e.kind).toBe('scope');
    } else {
      throw new Error('should be agent error');
    }
    expect(isAgentError(new Error('x'))).toBe(false);
  });

  it('error.name matches the constructor name (for log/Sentry grouping)', () => {
    expect(new AgentAuthError('').name).toBe('AgentAuthError');
    expect(new AgentTimeoutError('').name).toBe('AgentTimeoutError');
    expect(new AgentSoftFailError('').name).toBe('AgentSoftFailError');
    expect(new AgentValidationError('').name).toBe('AgentValidationError');
    expect(new AgentScopeError('').name).toBe('AgentScopeError');
  });

  it('does not leak optional fields when omitted', () => {
    const err = new AgentAuthError('bare');
    expect(err.agent).toBeUndefined();
    expect(err.intent).toBeUndefined();
    expect(err.cause).toBeUndefined();
    expect(err.detail).toBeUndefined();
  });
});
