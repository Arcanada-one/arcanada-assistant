import { z } from 'zod';

/**
 * Recursive json-logic AST used by `agent-approval-policy.yaml` conditional
 * rules. Closed grammar — no `eval` / `Function` / `vm.runInNewContext`. The
 * operator names match json-logic-js semantics: `!` is unary negation (not
 * `not`); `==` / `===` / `!=` / `!==` follow JS equality rules; comparison
 * operands may themselves be predicates (e.g. `{var: 'payload.count'}`). See
 * creative-ARCA-0009-algorithm-approval-predicate-grammar.md for the design
 * rationale.
 */
export type PredicateAst =
  | { and: PredicateAst[] }
  | { or: PredicateAst[] }
  | { '!': PredicateAst }
  | { '==': [PredicateAst, PredicateAst] }
  | { '===': [PredicateAst, PredicateAst] }
  | { '!=': [PredicateAst, PredicateAst] }
  | { '!==': [PredicateAst, PredicateAst] }
  | { '<': [PredicateAst, PredicateAst] }
  | { '<=': [PredicateAst, PredicateAst] }
  | { '>': [PredicateAst, PredicateAst] }
  | { '>=': [PredicateAst, PredicateAst] }
  | { in: [PredicateAst, PredicateAst[]] }
  | { var: string }
  | boolean
  | string
  | number
  | null
  | PredicateAst[];

export const predicateAstSchema: z.ZodType<PredicateAst> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(predicateAstSchema).min(1) }).strict(),
    z.object({ or: z.array(predicateAstSchema).min(1) }).strict(),
    z.object({ '!': predicateAstSchema }).strict(),
    z.object({ '==': z.tuple([predicateAstSchema, predicateAstSchema]) }).strict(),
    z.object({ '===': z.tuple([predicateAstSchema, predicateAstSchema]) }).strict(),
    z.object({ '!=': z.tuple([predicateAstSchema, predicateAstSchema]) }).strict(),
    z.object({ '!==': z.tuple([predicateAstSchema, predicateAstSchema]) }).strict(),
    z.object({ '<': z.tuple([predicateAstSchema, predicateAstSchema]) }).strict(),
    z.object({ '<=': z.tuple([predicateAstSchema, predicateAstSchema]) }).strict(),
    z.object({ '>': z.tuple([predicateAstSchema, predicateAstSchema]) }).strict(),
    z.object({ '>=': z.tuple([predicateAstSchema, predicateAstSchema]) }).strict(),
    z.object({ in: z.tuple([predicateAstSchema, z.array(predicateAstSchema)]) }).strict(),
    z.object({ var: z.string().min(1).max(128) }).strict(),
    z.boolean(),
    z.string(),
    z.number(),
    z.null(),
    z.array(predicateAstSchema),
  ]),
);
