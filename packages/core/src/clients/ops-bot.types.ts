import { z } from 'zod';

import { OpsBotEventSchema, type OpsBotEventCategory } from '../types/schemas.js';

export { OpsBotEventSchema, OpsBotEventCategory } from '../types/schemas.js';
export type { OpsBotEvent } from '../types/schemas.js';

/**
 * Acknowledgement returned by `POST {opsBotUrl}/events`. Ops Bot writes the
 * event to its inbox and responds with an opaque event_id (currently ULID)
 * plus a status hint. Optional `received_at` is server timestamp.
 */
export const EmitEventResponseSchema = z.object({
  event_id: z.string().min(1),
  status: z.enum(['accepted', 'rejected', 'duplicate']),
  received_at: z.iso.datetime().optional(),
});
export type EmitEventResponse = z.infer<typeof EmitEventResponseSchema>;

/**
 * Structured shape derived from `GET {opsBotUrl}/metrics` (Prometheus text).
 * The shape is what assistant /status и /agents handlers ultimately render to
 * the operator. Keep это compact — broader analytics belongs в Ops Bot itself.
 */
export const EcosystemSnapshotSchema = z.object({
  agents_total: z.number().int().nonnegative(),
  events_total: z.number().int().nonnegative(),
  approvals_pending: z.number().int().nonnegative(),
  parsed_at: z.iso.datetime(),
});
export type EcosystemSnapshot = z.infer<typeof EcosystemSnapshotSchema>;

/**
 * Input to `IOpsBotClient.emitEvent` — re-uses canonical OpsBotEventSchema
 * but без обязательного timestamp (client заполняет). Consumer-facing alias.
 */
export const EmitEventInputSchema = OpsBotEventSchema.omit({ timestamp: true }).extend({
  timestamp: z.iso.datetime().optional(),
});
export type EmitEventInput = z.infer<typeof EmitEventInputSchema>;

/**
 * ARCA-0122: the actual `POST /events` wire body Ops Bot accepts
 * (`Arcanada-one/opsbot` `src/modules/events/dto/create-event.dto.ts`
 * `CreateEventDto`, minus the `approval`/`github_workflow` discriminator
 * payloads assistant never emits). `OpsBotEventSchema` above is the richer
 * internal representation assistant call sites use (`service`/`severity`/
 * `context`/`audit_ref`); this schema and `toOpsBotWireEvent` below are the
 * boundary that translates one into the other. No shared package exists
 * between the two repos yet — keep this in sync with opsbot's DTO by hand.
 */
export const OpsBotWireEventCategory = [
  'fatal',
  'warning',
  'approval',
  'digest',
  'info',
  'heartbeat',
  'feedback',
] as const;
export type OpsBotWireEventCategory = (typeof OpsBotWireEventCategory)[number];

export const OpsBotWireEventSchema = z.object({
  category: z.enum(OpsBotWireEventCategory),
  agent: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  body: z.string().max(4000),
  dedup_key: z.string().min(1).max(128).optional(),
});
export type OpsBotWireEvent = z.infer<typeof OpsBotWireEventSchema>;

const WIRE_TITLE_MAX = 256;
const WIRE_BODY_MAX = 4000;
const WIRE_DEDUP_MAX = 128;

/**
 * `OpsBotEventCategory` → `OpsBotWireEventCategory`. Assistant's `self_heal`/
 * `tool_failure`/`cost_breaker_trip`/`briefing_cycle`/`audit` have no direct
 * opsbot counterpart; mapped by severity/intent rather than name.
 */
const CATEGORY_TO_WIRE: Record<OpsBotEventCategory, OpsBotWireEventCategory> = {
  fatal: 'fatal',
  warning: 'warning',
  tool_failure: 'warning',
  cost_breaker_trip: 'warning',
  self_heal: 'info',
  briefing_cycle: 'digest',
  audit: 'info',
};

/**
 * Translates a validated `EmitEventInput` into the shape Ops Bot's
 * `CreateEventDto` actually accepts. Truncates `title`/`body`/`dedup_key`
 * defensively to opsbot's field limits rather than letting a long message
 * fail Zod validation on the receiving side.
 */
export function toOpsBotWireEvent(event: EmitEventInput): OpsBotWireEvent {
  const category = CATEGORY_TO_WIRE[event.category];
  const title =
    event.message.length > WIRE_TITLE_MAX
      ? `${event.message.slice(0, WIRE_TITLE_MAX - 1)}…`
      : event.message;
  const body = event.context ? JSON.stringify(event.context).slice(0, WIRE_BODY_MAX) : '';
  const dedup_key = event.audit_ref?.slice(0, WIRE_DEDUP_MAX);
  return OpsBotWireEventSchema.parse({
    category,
    agent: event.service,
    title,
    body,
    ...(dedup_key ? { dedup_key } : {}),
  });
}

/**
 * Bidirectional Ops Bot command kinds (ARCA-0009 M3, PRD V-AC-3).
 *
 * — `echo-back`: non-destructive round-trip probe. Ops Bot returns `{echo: <payload>}`.
 *   Canonical V-AC-3 manual smoke: `/ops echo-back ARCA-0009`.
 * — `health-probe`: ask Ops Bot to run its own readiness probe and return shape
 *   `{ready: bool, deps?: object}`. Used by AAL L3 cross-agent liveness.
 *
 * Closed enum — new commands MUST be added explicitly to keep the contract tight
 * (threat-model T4 — unauthorised command execution).
 */
export const OpsBotCommandKindSchema = z.enum(['echo-back', 'health-probe']);
export type OpsBotCommandKind = z.infer<typeof OpsBotCommandKindSchema>;

/**
 * Input to `IOpsBotClient.executeCommand`. The `idempotencyKey` MUST be UUID v7
 * (time-sortable, per Auth Arcana mandate) so Ops Bot can dedupe replays without
 * coordinating clocks. Caller is responsible for generation.
 */
export const ExecuteCommandInputSchema = z.object({
  cmd: OpsBotCommandKindSchema,
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.uuid(),
});
export type ExecuteCommandInput = z.infer<typeof ExecuteCommandInputSchema>;

/**
 * Ops Bot response shape from `POST {opsBotUrl}/commands`. `command_id` is the
 * server-assigned ULID/UUID for downstream correlation (audit + tracing).
 * `result` is command-specific — Zod cannot strongly type it without
 * discriminating on `cmd`, so it stays `record`.
 */
export const ExecuteCommandResponseSchema = z.object({
  ok: z.boolean(),
  command_id: z.string().min(1),
  result: z.record(z.string(), z.unknown()).optional(),
  executed_at: z.iso.datetime(),
});
export type ExecuteCommandResponse = z.infer<typeof ExecuteCommandResponseSchema>;
