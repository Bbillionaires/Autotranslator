/**
 * Zod schemas for the Android SMS gateway API contract, per docs/implementation-plan.md
 * §5/§6.3 and the Phase 8 task brief. Shared between the Route Handlers
 * (`src/app/api/gateways/**`) and `AndroidSmsAdapter`/its parser (`../channels/androidSms/parse.ts`).
 */
import { z } from "zod";
import { ANDROID_FAILURE_REASONS } from "../gateways/androidFailureReasons";

/** `POST /api/gateways/register` — Session+Role(Administrator+), per the route's own auth check. */
export const registerDeviceSchema = z.object({
  deviceName: z.string().min(1, "Device name is required.").max(200),
  phoneNumber: z
    .string()
    .min(3, "Phone number is required.")
    .max(32)
    .regex(/^\+?[0-9()\-.\s]+$/, "Phone number contains invalid characters."),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

/** `POST /api/gateways/inbound` — device-token authenticated. */
export const inboundSmsSchema = z.object({
  from: z
    .string()
    .min(3, "from (sender phone number) is required.")
    .max(32)
    .regex(/^\+?[0-9()\-.\s]+$/, "from contains invalid characters."),
  text: z.string().min(1, "text is required.").max(10_000),
  sentAt: z.coerce.date(),
  /** The device's own dedup reference (e.g. derived from SMS timestamp + sender on-device). */
  externalMessageId: z.string().min(1, "externalMessageId is required.").max(200),
});
export type InboundSmsInput = z.infer<typeof inboundSmsSchema>;

/** `POST /api/gateways/messages/:id/acknowledge` — device-token authenticated. */
export const acknowledgeMessageSchema = z.object({
  /** The device's own SMS-send confirmation reference, if it has one. Optional — some Android SmsManager callbacks carry no useful id. */
  externalMessageId: z.string().max(200).optional(),
});
export type AcknowledgeMessageInput = z.infer<typeof acknowledgeMessageSchema>;

/** `POST /api/gateways/messages/:id/fail` — device-token authenticated. */
export const failMessageSchema = z.object({
  reason: z.enum(ANDROID_FAILURE_REASONS),
});
export type FailMessageInput = z.infer<typeof failMessageSchema>;

/** `GET /api/gateways/messages/pending` — optional page-size override, capped server-side regardless. */
export const listPendingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
