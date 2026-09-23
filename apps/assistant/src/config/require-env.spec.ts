import { afterEach, describe, expect, it } from 'vitest';

import { MissingEnvError, requireEnv } from './require-env.js';

const VAR = 'A2_226_PROBE_URL';

describe('requireEnv', () => {
  afterEach(() => {
    delete process.env[VAR];
  });

  it('returns the value when the variable is set', () => {
    process.env[VAR] = 'redis://redis.invalid:6379/3';
    expect(requireEnv(VAR)).toBe('redis://redis.invalid:6379/3');
  });

  it('throws MissingEnvError naming the variable when unset', () => {
    delete process.env[VAR];
    expect(() => requireEnv(VAR)).toThrow(MissingEnvError);
    expect(() => requireEnv(VAR)).toThrow(VAR);
  });

  it('treats an empty / whitespace-only value as unset', () => {
    process.env[VAR] = '   ';
    expect(() => requireEnv(VAR)).toThrow(MissingEnvError);
  });

  it('exposes the variable name on the error', () => {
    delete process.env[VAR];
    try {
      requireEnv(VAR);
      expect.unreachable('requireEnv must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvError);
      expect((err as MissingEnvError).variable).toBe(VAR);
    }
  });

  it('does not invent a localhost default', () => {
    delete process.env[VAR];
    expect(() => requireEnv(VAR)).toThrow(/not set/i);
    expect(() => requireEnv(VAR)).not.toThrow(/localhost/);
  });
});
