/**
 * Applies a channel's async delivery-status callback (WhatsApp's `statuses[]` webhook
 * entries today; any future channel with the same "sent/delivered/read/failed" callback
 * shape can reuse this) to the corresponding outbound `Message`, per
 * docs/implementation-plan.md §3.6 step 7 and the Phase 9 task brief's design question:
 * "decide how status callbacks flow into Phase 5's MessageEvent/status-transition logic".
 *
 * ## Design choice
 * A status callback is NOT a new inbound message — it updates an EXISTING `Message` row
 * found by `externalMessageId`, and records its own `MessageEvent` for audit/idempotency.
 * This is deliberately a separate module/function from `inboundService.processInboundMessage`
 * (which only ever *creates* a `Message`) and from `outboundService.ts` (which owns the
 * *outbound send* half of the lifecycle) — the WhatsApp webhook route calls this in its own
 * branch, parallel to (not inside) the `processInboundMessage` call for real inbound
 * messages. See `../channels/whatsapp/parse.ts`'s module doc comment for the full rationale.
 *
 * ## Idempotency
 * The `MessageEvent` insert is attempted FIRST and its unique-constraint violation
 * (`@@unique([messageId, eventType, externalEventId])`) is the idempotency backstop — same
 * "attempt the write, catch P2002" pattern as every other dedupe in this codebase
 * (`messageRepository`'s idempotencyKey, `inboundService`'s duplicate-webhook handling).
 * `externalEventId` is caller-supplied (see `../channels/whatsapp/parse.ts`'s
 * `mapWhatsAppStatus`, which derives `${id}:${status}:${timestamp}`) precisely so a Meta
 * webhook retry delivering the IDENTICAL status callback twice collapses onto the same row
 * instead of double-recording — proven by this module's own tests and by the webhook
 * route's integration test.
 *
 * ## Out-of-order / invalid transitions
 * Real-world webhook delivery has no ordering guarantee. If a callback's target status isn't
 * a valid forward transition from the message's CURRENT status (e.g. a `read` arriving after
 * the message was already marked `FAILED` by an earlier callback, or a genuinely
 * out-of-order delivery), this function does NOT throw — it still records the `MessageEvent`
 * (so the raw signal is never lost/audit-invisible) but leaves `Message.status` untouched,
 * logging a warning. This keeps the webhook route's 200-quickly contract intact (§5: "Must
 * return 200 quickly") even under out-of-order delivery, rather than surfacing a
 * `ConflictError` for something that isn't actually an application bug.
 */
import type { Message } from "@prisma/client";
import type { DeliveryStatusUpdate } from "../channels/types";
import { isUniqueConstraintViolation } from "../db";
import { withContext } from "../logger";
import { messageEventRepository, type MessageEventType } from "../repositories/messageEventRepository";
import { messageRepository } from "../repositories/messageRepository";
import { canTransition } from "./retryQueue";

const STATUS_TO_EVENT_TYPE: Record<DeliveryStatusUpdate["status"], MessageEventType> = {
  SENT: "sent",
  DELIVERED: "delivered",
  READ: "read",
  FAILED: "failed",
};

export type ApplyDeliveryStatusIgnoredReason = "message_not_found" | "duplicate" | "invalid_transition";

export interface ApplyDeliveryStatusResult {
  /** True when this call recorded a NEW `MessageEvent` (whether or not the status transition itself was applied — see `ignoredReason: "invalid_transition"`). */
  recorded: boolean;
  ignoredReason?: ApplyDeliveryStatusIgnoredReason;
  message?: Message;
}

/**
 * Applies one delivery-status callback. `externalEventId` must be a value that's stable and
 * identical across retried deliveries of the SAME status event, and DIFFERENT across
 * genuinely distinct status events for the same message (e.g. "delivered" then "read") — see
 * `../channels/whatsapp/parse.ts`'s `mapWhatsAppStatus` for how WhatsApp's callback derives
 * one.
 */
export async function applyDeliveryStatusUpdate(
  organizationId: string,
  update: DeliveryStatusUpdate,
  externalEventId: string,
): Promise<ApplyDeliveryStatusResult> {
  const log = withContext({ organizationId, externalMessageId: update.externalMessageId });

  const message = await messageRepository.findByExternalMessageId(organizationId, update.externalMessageId);
  if (!message) {
    log.warn({ status: update.status }, "delivery_status_callback_unknown_message");
    return { recorded: false, ignoredReason: "message_not_found" };
  }

  const eventType = STATUS_TO_EVENT_TYPE[update.status];

  try {
    await messageEventRepository.create({
      messageId: message.id,
      eventType,
      externalEventId,
      payload: {
        status: update.status,
        occurredAt: update.occurredAt.toISOString(),
        failureReason: update.failureReason ?? null,
      },
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      log.info({ eventType, externalEventId }, "duplicate_status_callback_ignored");
      return { recorded: false, ignoredReason: "duplicate", message };
    }
    throw error;
  }

  if (!canTransition(message.status, update.status)) {
    log.warn({ from: message.status, to: update.status }, "delivery_status_callback_out_of_order_transition_ignored");
    return { recorded: true, ignoredReason: "invalid_transition", message };
  }

  const updated = await messageRepository.updateStatus(organizationId, message.id, update.status, {
    failureReason: update.failureReason ?? null,
  });
  return { recorded: true, message: updated };
}
