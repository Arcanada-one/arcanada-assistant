import { z } from 'zod';

import { OpsBotEventSchema } from '../types/schemas.js';

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
