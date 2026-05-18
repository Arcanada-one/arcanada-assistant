import { describe, expect, it } from 'vitest';

import { evaluatePredicate, PredicateEvalError } from './predicate-eval.js';

describe('evaluatePredicate', () => {
  it('returns true for boolean literal true', () => {
    expect(evaluatePredicate(true, {})).toBe(true);
  });

  it('returns false for boolean literal false', () => {
    expect(evaluatePredicate(false, {})).toBe(false);
  });

  it('reads nested payload variables', () => {
    const ast = { '==': [{ var: 'payload.where' }, null] };
    expect(evaluatePredicate(ast, { payload: { where: null } })).toBe(true);
    expect(evaluatePredicate(ast, { payload: { where: 'narrow' } })).toBe(false);
  });

  it('supports and / or / ! composition', () => {
    const ast = {
      and: [
        { '==': [{ var: 'tool.name' }, 'task_query'] },
        { '!': { '==': [{ var: 'payload.where' }, 'sensitive'] } },
      ],
    };
    expect(
      evaluatePredicate(ast, { tool: { name: 'task_query' }, payload: { where: 'open' } }),
    ).toBe(true);
    expect(
      evaluatePredicate(ast, { tool: { name: 'task_query' }, payload: { where: 'sensitive' } }),
    ).toBe(false);
  });

  it('supports numeric comparisons (< <= > >=)', () => {
    const ast = { '<': [{ var: 'payload.count' }, 10] };
    expect(evaluatePredicate(ast, { payload: { count: 5 } })).toBe(true);
    expect(evaluatePredicate(ast, { payload: { count: 15 } })).toBe(false);
  });

  it('supports the `in` operator', () => {
    const ast = { in: [{ var: 'tool.name' }, ['task_create', 'task_update']] };
    expect(evaluatePredicate(ast, { tool: { name: 'task_create' } })).toBe(true);
    expect(evaluatePredicate(ast, { tool: { name: 'task_get' } })).toBe(false);
  });

  it('rejects malformed AST (eval-style payload)', () => {
    expect(() =>
      evaluatePredicate({ method: 'eval', code: 'process.exit()' } as never, {}),
    ).toThrow(PredicateEvalError);
  });

  it('rejects AST with empty and[]', () => {
    expect(() => evaluatePredicate({ and: [] } as never, {})).toThrow(PredicateEvalError);
  });
});
