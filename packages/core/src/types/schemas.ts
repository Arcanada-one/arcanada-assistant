import { z } from 'zod';

/**
 * Canonical Ops Bot event categories. Per ADR-4 + AAL Mandate § 8 — emitted
 * к https://ops.arcanada.one/events. Extending the enum requires Ops Bot
 * subscription update on the receiving side.
 */
export const OpsBotEventCategory = [
  'fatal',
  'self_heal',
  'cost_breaker_trip',
  'briefing_cycle',
  'tool_failure',
  'warning',
] as const;
export type OpsBotEventCategory = (typeof OpsBotEventCategory)[number];

export const OpsBotEventSchema = z.object({
  service: z.string().min(1),
  category: z.enum(OpsBotEventCategory),
  severity: z.enum(['info', 'warning', 'error', 'fatal']),
  message: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
  audit_ref: z.string().optional(),
  timestamp: z.iso.datetime(),
});
export type OpsBotEvent = z.infer<typeof OpsBotEventSchema>;

/**
 * Stub schema for Telegram Update — covers only the fields ARCA-0006 echo
 * handler needs (update_id для дедупликации + базовое message-поле). Full
 * Telegram-typed schema живёт в Telegraf typings; we use this stub только
 * для Zod-валидации webhook бодей, чтобы не парсить через class-validator.
 */
export const TelegramUpdateStubSchema = z.object({
  update_id: z.number().int(),
  message: z
    .object({
      message_id: z.number().int().optional(),
      date: z.number().int().optional(),
      chat: z.object({ id: z.number().int(), type: z.string() }).optional(),
      from: z
        .object({
          id: z.number().int(),
          is_bot: z.boolean().optional(),
          first_name: z.string().optional(),
        })
        .optional(),
      text: z.string().optional(),
    })
    .optional(),
});
export type TelegramUpdateStub = z.infer<typeof TelegramUpdateStubSchema>;
