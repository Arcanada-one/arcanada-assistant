import { z } from 'zod';

export const MUNERA_TASK_STATUSES = [
  'todo',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
] as const;

export const MUNERA_TASK_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

/**
 * A2-281 — what a READ may legally come back with. `archived` is a real
 * Muneral status (`TASK_TRANSITIONS` in `@muneral/types`, terminal and NOT a
 * synonym for `done` — MUN-0043), but it was missing from the list above, and
 * the list above is what `MuneraTaskSchema` validated against. One archived
 * row anywhere in a page therefore failed the whole parse, and a failed parse
 * is reported as `unavailable` — an outage invented by our own enum. The write
 * enums keep the narrower list on purpose: this client never asks for a move
 * to `archived`.
 */
export const MUNERA_TASK_STATUSES_READ = [...MUNERA_TASK_STATUSES, 'archived'] as const;

export type MuneraTaskStatus = (typeof MUNERA_TASK_STATUSES)[number];
export type MuneraTaskStatusRead = (typeof MUNERA_TASK_STATUSES_READ)[number];
export type MuneraTaskPriority = (typeof MUNERA_TASK_PRIORITIES)[number];

export const CreateTaskRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    sprintId: z.string().uuid().optional(),
    parentId: z.string().uuid().optional(),
    title: z.string().min(1).max(500),
    description: z.string().optional(),
    status: z.enum(MUNERA_TASK_STATUSES).optional(),
    priority: z.enum(MUNERA_TASK_PRIORITIES).optional(),
    dueDate: z.string().datetime({ offset: true }).optional(),
    estimateHours: z.number().nonnegative().optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const UpdateTaskStatusRequestSchema = z
  .object({
    status: z.enum(MUNERA_TASK_STATUSES),
  })
  .strict();
export type UpdateTaskStatusRequest = z.infer<typeof UpdateTaskStatusRequestSchema>;

export const MuneraTaskSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    title: z.string(),
    description: z.string().nullable().optional(),
    status: z.enum(MUNERA_TASK_STATUSES_READ),
    priority: z.enum(MUNERA_TASK_PRIORITIES).nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type MuneraTask = z.infer<typeof MuneraTaskSchema>;

export const MuneraTaskListSchema = z.array(MuneraTaskSchema);

/**
 * JwtAuthGuard 401 envelope — NestJS default `UnauthorizedException()`. No
 * `error` field present. Captured 2026-05-17 against `POST /api/v1/tasks` with
 * missing or malformed Bearer.
 */
export const MuneraJwtUnauthorizedEnvelopeSchema = z
  .object({
    statusCode: z.literal(401),
    message: z.string().min(1),
  })
  .strict();

/**
 * ApiKeyGuard 401 envelope — NestJS `UnauthorizedException('API key required')`
 * with default `error: 'Unauthorized'`. Captured 2026-05-17 against
 * `GET /api/v1/agents/tasks` with missing / wrong-prefix / unknown `x-api-key`.
 */
export const MuneraApiKeyUnauthorizedEnvelopeSchema = z
  .object({
    statusCode: z.literal(401),
    error: z.literal('Unauthorized'),
    message: z.string().min(1),
  })
  .strict();

/**
 * Global filter shape (400/404/etc.) — used by `class-validator` and Nest
 * default `NotFoundException` / `BadRequestException`. The `message` field can
 * be either a string or an array of validator error messages.
 */
export const MuneraGlobalErrorEnvelopeSchema = z
  .object({
    statusCode: z.number().int(),
    error: z.string().min(1),
    message: z.union([z.string().min(1), z.array(z.string()).min(1)]),
  })
  .strict();

export type MuneraGlobalErrorEnvelope = z.infer<typeof MuneraGlobalErrorEnvelopeSchema>;

export const TaskResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    task: MuneraTaskSchema,
  }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.string().min(1),
    statusCode: z.number().int().optional(),
    errorCode: z.string().optional(),
    detail: z.string().optional(),
  }),
]);
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const TaskListResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    tasks: MuneraTaskListSchema,
  }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.string().min(1),
    statusCode: z.number().int().optional(),
    errorCode: z.string().optional(),
    detail: z.string().optional(),
  }),
]);
export type TaskListResult = z.infer<typeof TaskListResultSchema>;

/**
 * A2-281 — the envelope of `GET /api/v1/tasks` (Muneral `TasksService.query`,
 * `apps/api/src/tasks/tasks.service.ts`). `total` is the count BEFORE paging,
 * and it is the reason this route exists: an empty page with no count is
 * exactly the shape that reads as a clean bill of health.
 */
export const MuneraTaskPageSchema = z
  .object({
    items: MuneraTaskListSchema,
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .passthrough();
export type MuneraTaskPage = z.infer<typeof MuneraTaskPageSchema>;

export const TaskPageResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    page: MuneraTaskPageSchema,
  }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.string().min(1),
    statusCode: z.number().int().optional(),
    errorCode: z.string().optional(),
    detail: z.string().optional(),
  }),
]);
export type TaskPageResult = z.infer<typeof TaskPageResultSchema>;

/** Filters accepted by `GET /api/v1/tasks` — `QueryTasksDto` in Muneral. */
export const MuneraTaskQuerySchema = z
  .object({
    status: z.enum(MUNERA_TASK_STATUSES_READ).optional(),
    projectId: z.string().uuid().optional(),
    /** ISO-8601, inclusive: `updatedAt >= updatedSince`. */
    updatedSince: z.string().min(1).optional(),
    /** ISO-8601, exclusive: `updatedAt < updatedBefore`. */
    updatedBefore: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();
export type MuneraTaskQuery = z.infer<typeof MuneraTaskQuerySchema>;
