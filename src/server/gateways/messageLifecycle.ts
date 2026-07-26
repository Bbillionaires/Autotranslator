/**
 * Android gateway message-lifecycle operations (`GET /messages/pending`,
 * `POST /messages/:id/acknowledge`, `POST /messages/:id/fail`), per
 * docs/implementation-plan.md §3.6/§5 and the Phase 8 task brief. Kept separate from the
 * Route Handlers so the device/org-isolation logic and idempotency handling are unit- and
 * integration-testable without constructing `Request` objects, and separate from
 * `AndroidSmsAdapter` itself because these operate on `Message` rows directly (repository
 * calls), which adapters in this codebase deliberately never do (see the adapter's module
 * doc comment on `sendMessage`'s "no I/O" design).
 */
import type { ChannelAccount, Message } from "@prisma/client";
import { isUniqueConstraintViolation } from "../db";
import { NotFoundError } from "../errors";
import { handleSendFailure, type SendMessageResult } from "../messaging/outboundService";
import { assertValidTransition } from "../messaging/retryQueue";
import { messageEventRepository } from "../repositories/messageEventRepository";
import { messageRepository } from "../repositories/messageRepository";
import type { AndroidFailureReason } from "./androidFailureReasons";
import { toGatewayFailureError } from "./androidFailureReasons";

export interface PendingGatewayMessage {
  id: string;
  to: string | null;
  text: string;
  createdAt: Date;
}

/**
 * `GET /api/gateways/messages/pending`: the device's own queued outbound SMS, oldest-first,
 * capped at `limit` (already clamped to <= 100 by the Zod schema / route). Org- AND
 * device-scoped via `messageRepository.listQueuedForChannelAccount` — see that method's
 * doc comment for why device-scoping (not just org-scoping) matters once an org has more
 * than one registered device.
 */
export async function listPendingMessagesForDevice(
  channelAccount: ChannelAccount,
  limit?: number,
): Promise<PendingGatewayMessage[]> {
  const messages = await messageRepository.listQueuedForChannelAccount(channelAccount.organizationId, channelAccount.id, {
    take: limit,
  });

  return messages.map((message) => ({
    id: message.id,
    to: message.conversation.contact.phoneNumber,
    text: message.translatedText ?? message.originalText,
    createdAt: message.createdAt,
  }));
}

/**
 * Loads a `Message` for an acknowledge/fail call, enforcing device isolation (the message's
 * conversation must belong to THIS device's `ChannelAccount`, not merely the same org).
 * Throws `NotFoundError` (surfaced as a generic 404 by the route, never distinguishing
 * "wrong org" from "wrong device" from "doesn't exist") when the check fails.
 */
async function requireMessageForDevice(channelAccount: ChannelAccount, messageId: string): Promise<Message> {
  const message = await messageRepository.findForChannelAccountOrNull(channelAccount.organizationId, channelAccount.id, messageId);
  if (!message) {
    throw new NotFoundError("Message not found for this device.", { channelAccountId: channelAccount.id, messageId });
  }
  return message;
}

/**
 * `POST /api/gateways/messages/:id/acknowledge`: the device confirms it actually sent the
 * SMS via `SmsManager`. Transitions `QUEUED`/`PENDING` -> `SENT` — never optimistically,
 * only on this explicit device confirmation (§3.6 step 5's invariant, honored one hop later
 * for this channel — see `AndroidSmsAdapter`'s module doc comment).
 *
 * Idempotent on repeated calls (deliverable #6): if the message is already `SENT` (or
 * further along: `DELIVERED`/`READ`), this is a no-op that returns the current row —
 * calling twice never errors and never double-transitions. The one `MessageEvent` this
 * writes (`eventType: "device_acknowledged"`) is deduplicated via the schema's
 * `@@unique([messageId, eventType, externalEventId])` constraint: the status transition
 * happens FIRST (and is itself idempotent via the early-return check below), so even a
 * genuine race between two concurrent acknowledge calls has the event-insert unique
 * constraint as the final backstop against a duplicate `MessageEvent` row — the second
 * insert's P2002 is caught and swallowed, not surfaced as an error.
 */
export async function acknowledgeMessage(
  channelAccount: ChannelAccount,
  messageId: string,
  externalMessageId: string | undefined,
): Promise<Message> {
  const message = await requireMessageForDevice(channelAccount, messageId);

  if (message.status === "SENT" || message.status === "DELIVERED" || message.status === "READ") {
    return message; // already acknowledged (or moved further) — idempotent no-op.
  }

  assertValidTransition(message.status, "SENT");
  const updated = await messageRepository.updateStatus(channelAccount.organizationId, messageId, "SENT", {
    externalMessageId: externalMessageId ?? message.externalMessageId,
  });

  // Deterministic externalEventId when the device doesn't supply its own SMS reference, so
  // the unique constraint (messageId, eventType, externalEventId) reliably catches a
  // concurrent duplicate ack even without a device-supplied id to key on.
  const eventExternalId = externalMessageId?.trim() || "device-ack";
  try {
    await messageEventRepository.create({
      messageId,
      eventType: "device_acknowledged",
      externalEventId: eventExternalId,
      payload: { source: "android_gateway", deviceChannelAccountId: channelAccount.id },
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    // A racing duplicate ack already recorded this event — not an error, just a no-op here.
  }

  return updated;
}

/**
 * `POST /api/gateways/messages/:id/fail`: the device reports it could NOT send the SMS
 * (carrier/SIM/device-observed error — see `./androidFailureReasons.ts`). Reuses
 * `outboundService.handleSendFailure` (exported specifically for this) so transient-vs-
 * permanent classification, retry scheduling, DEAD_LETTER-on-attempt-cap, and `MessageEvent`
 * recording are the exact same code path a thrown-adapter-error failure would take —
 * nothing about the retry queue treats "device told us it failed" as a special case.
 */
export async function failMessage(channelAccount: ChannelAccount, messageId: string, reason: AndroidFailureReason): Promise<SendMessageResult> {
  const message = await requireMessageForDevice(channelAccount, messageId);
  const error = toGatewayFailureError(reason);
  return handleSendFailure(channelAccount.organizationId, message, error);
}
