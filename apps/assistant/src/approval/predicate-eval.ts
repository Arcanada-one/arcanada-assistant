import jsonLogic from 'json-logic-js';

import { predicateAstSchema, type PredicateAst } from './predicate-ast.schema.js';

/**
 * Evaluates a json-logic AST against the provided context.
 *
 * The Zod schema validates the AST grammar before evaluation: any non-grammar
 * shape is rejected up-front, so the evaluator never sees eval-style payloads
 * such as `{"method": "..."}` extensions that json-logic-js might otherwise
 * load via `add_operation`. We never call `add_operation` here.
 */
export function evaluatePredicate(ast: PredicateAst, context: Record<string, unknown>): boolean {
  const parsed = predicateAstSchema.safeParse(ast);
  if (!parsed.success) {
    throw new PredicateEvalError(`invalid predicate AST: ${parsed.error.message}`);
  }
  // jsonLogic.apply returns `unknown`; coerce to strict boolean for guard semantics.
  // Falsy values (0, '', null) → false; everything else → boolean(jsonLogic.apply(...)).
  const result = jsonLogic.apply(parsed.data as unknown as Record<string, unknown>, context);
  return Boolean(result);
}

export class PredicateEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PredicateEvalError';
  }
}
