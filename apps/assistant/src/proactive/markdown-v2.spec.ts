import { describe, expect, it } from 'vitest';

import { bold, escapeMd } from './markdown-v2.js';

describe('escapeMd', () => {
  it('escapes dots in version numbers', () => {
    expect(escapeMd('v1.2.3')).toBe('v1\\.2\\.3');
  });

  it('escapes hyphens in task IDs', () => {
    expect(escapeMd('ARCA-0010')).toBe('ARCA\\-0010');
  });

  it('escapes asterisks and brackets', () => {
    expect(escapeMd('foo*[bar]')).toBe('foo\\*\\[bar\\]');
  });

  it('leaves plain text untouched', () => {
    expect(escapeMd('plain text 123')).toBe('plain text 123');
  });
});

describe('bold', () => {
  it('wraps with asterisks and escapes interior', () => {
    expect(bold('ARCA-0010')).toBe('*ARCA\\-0010*');
  });
});
