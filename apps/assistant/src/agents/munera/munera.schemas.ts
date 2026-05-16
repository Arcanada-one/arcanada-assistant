import { z } from 'zod';

export const MUNERA_TASK_STATUSES = [
  'todo',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
] as const;

export const MUNERA_TASK_PRIORITIES = [
  'critical',
  'high',
  'medium',
  'low',
] as const;

export type MuneraTaskStatus = (typeof MUNERA_TASK_STATUSES)[number];
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
    status: z.enum(MUNERA_TASK_STATUSES),
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
