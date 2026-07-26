/**
 * Pure normalization helpers for Meta's WhatsApp Business Cloud API webhook payload shape,
 * per docs/implementation-plan.md §3.2/§3.5 and the Phase 9 task brief. No Prisma/env
 * dependency — these are plain functions over the payload's JSON shape, unit-tested against
 * fixture payloads captured/representative of Meta's documented webhook format.
 *
 * Meta's payload nests everything under `entry[].changes[].value`, and a single `value` can
 * carry EITHER new inbound `messages[]` OR delivery-status `statuses[]` callbacks (never
 * both meaningfully mixed in this MVP's fixtures, though the shape technically allows it —
 * `extractWhatsAppValueBlocks` handles both being present on the same `value` regardless).
 * `value.metadata.phone_number_id` identifies which of *our* `ChannelAccount`s (by
 * `externalAccountId`) this block belongs to — see the module doc comment on
 * `channelAccountRepository.findActiveByChannelTypeAndExternalAccountId` for why this is a
 * per-block lookup (a single webhook delivery could, in principle, batch multiple business
 * phone numbers) rather than the single-global-lookup shortcut Telegram's adapter uses.
 *
 * ## Design choice: where do `statuses[]` (delivery-status callbacks) go?
 * `NormalizedInboundMessage` (../types.ts) models a *new inbound message* — sender,
 * timestamp, text. A delivery-status callback ("your outbound message was delivered/read")
 * is a completely different shape (no text, no sender-facing content) that updates an
 * EXISTING outbound `Message` row rather than creating a new one. Cramming it into
 * `NormalizedInboundMessage[]` would force `processInboundMessage` (Phase 5) to special-case
 * a shape it was never designed for. So `statuses[]` are surfaced separately — see
 * `extractWhatsAppValueBlocks` below and `../../messaging/deliveryStatusService.ts`, which
 * the webhook route (`src/app/api/channels/whatsapp/webhook/route.ts`) calls in a distinct
 * branch, parallel to (not inside) the `processInboundMessage` call for real messages.
 */
import type { NormalizedInboundMessage } from "../types";

export interface WhatsAppTextMessage {
  from: string; // sender's WhatsApp id / phone number, no leading "+"
  id: string; // Meta's message id ("wamid...."), globally unique per message
  timestamp: string; // unix epoch seconds, as a string
  type: string; // "text" | "image" | "audio" | "document" | ... — only "text" carries `.text.body`
  text?: { body: string };
  context?: { id: string }; // present when this message is a reply to another WhatsApp message
}

export interface WhatsAppStatusError {
  code: number;
  title: string;
  message?: string;
  error_data?: { details?: string };
}

export interface WhatsAppStatus {
  id: string; // the ORIGINAL outbound message's WhatsApp id — matches our stored externalMessageId
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string; // unix epoch seconds, as a string
  recipient_id: string;
  errors?: WhatsAppStatusError[];
}

export interface WhatsAppValue {
  messaging_product?: "whatsapp";
  metadata: { display_phone_number?: string; phone_number_id: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id: string }>;
  messages?: WhatsAppTextMessage[];
  statuses?: WhatsAppStatus[];
}

export interface WhatsAppChange {
  value: WhatsAppValue;
  field?: string;
}

export interface WhatsAppEntry {
  id?: string;
  changes?: WhatsAppChange[];
}

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: WhatsAppEntry[];
}

/** Resolves a `wa_id`'s display name from the `value.contacts[]` array, if present. */
function findContactName(value: WhatsAppValue, waId: string): string | undefined {
  return value.contacts?.find((contact) => contact.wa_id === waId)?.profile?.name;
}

/**
 * Normalizes a single `value.messages[]` entry into a `NormalizedInboundMessage`.
 *
 * Only `type: "text"` messages carry human-composed text this MVP can translate; every
 * other message type (image, audio, document, location, sticker, ...) is normalized to a
 * short bracketed placeholder describing the type rather than silently dropped — a human
 * agent should still see *something* arrived, even if rich-media handling itself is a
 * documented post-MVP gap (see docs/channel-adapters.md).
 */
function normalizeWhatsAppMessage(value: WhatsAppValue, message: WhatsAppTextMessage): NormalizedInboundMessage {
  const text = message.type === "text" && message.text ? message.text.body : `[unsupported WhatsApp message type: ${message.type}]`;
  return {
    externalContactId: message.from,
    externalUsername: findContactName(value, message.from),
    phoneNumber: message.from.startsWith("+") ? message.from : `+${message.from}`,
    externalMessageId: message.id,
    externalReplyToId: message.context?.id,
    text,
    sentAt: new Date(Number(message.timestamp) * 1000),
    raw: message,
  };
}

/**
 * Flattens EVERY `value.messages[]` entry across the whole payload into
 * `NormalizedInboundMessage[]`, ignoring which `phone_number_id`/`ChannelAccount` each
 * belongs to. This is `WhatsAppAdapter.parseInboundWebhook`'s implementation — kept for
 * `MessagingChannelAdapter` interface conformance and isolated unit testing, matching the
 * precedent set by `TelegramAdapter.parseInboundWebhook`/`AndroidSmsAdapter.parseInboundWebhook`
 * (both documented as "not necessarily what the live route calls" thin wrappers). The LIVE
 * webhook route uses `extractWhatsAppValueBlocks` instead, since it needs the
 * `phone_number_id` per block to resolve the correct `ChannelAccount` (§3.5 step 2/5) —
 * something this flattened, adapter-interface-shaped function deliberately doesn't surface.
 */
export function normalizeWhatsAppMessages(payload: WhatsAppWebhookPayload): NormalizedInboundMessage[] {
  const normalized: NormalizedInboundMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value.messages ?? []) {
        normalized.push(normalizeWhatsAppMessage(change.value, message));
      }
    }
  }
  return normalized;
}

export interface WhatsAppValueBlock {
  phoneNumberId: string;
  messages: NormalizedInboundMessage[];
  statuses: WhatsAppStatus[];
}

/**
 * Groups the payload's `value` blocks by `phone_number_id`, each carrying its own
 * normalized `messages[]` and raw `statuses[]` — the shape the live webhook route needs to
 * resolve the correct `ChannelAccount` per block (see the module doc comment's "Design
 * choice" section for why `statuses[]` stay raw here rather than being coerced into
 * `NormalizedInboundMessage`).
 */
export function extractWhatsAppValueBlocks(payload: WhatsAppWebhookPayload): WhatsAppValueBlock[] {
  const blocks: WhatsAppValueBlock[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const { value } = change;
      if (!value.metadata?.phone_number_id) continue;
      blocks.push({
        phoneNumberId: value.metadata.phone_number_id,
        messages: (value.messages ?? []).map((message) => normalizeWhatsAppMessage(value, message)),
        statuses: value.statuses ?? [],
      });
    }
  }
  return blocks;
}

const STATUS_MAP: Record<WhatsAppStatus["status"], "SENT" | "DELIVERED" | "READ" | "FAILED"> = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

export interface MappedWhatsAppStatus {
  externalMessageId: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  failureReason?: string;
  occurredAt: Date;
  /**
   * Derived idempotency key for the `MessageEvent` this status produces —
   * `${statusId}:${status}:${timestamp}` — so a Meta webhook retry delivering the exact same
   * status callback twice collapses onto the SAME `MessageEvent` row via the schema's
   * `@@unique([messageId, eventType, externalEventId])` constraint (see
   * `../../messaging/deliveryStatusService.ts`), rather than double-recording it. Meta has
   * no separate "status event id" of its own, unlike a message's `id`.
   */
  externalEventId: string;
}

/** Maps a single raw WhatsApp `statuses[]` entry into the shape `deliveryStatusService` consumes. */
export function mapWhatsAppStatus(status: WhatsAppStatus): MappedWhatsAppStatus {
  const firstError = status.errors?.[0];
  return {
    externalMessageId: status.id,
    status: STATUS_MAP[status.status],
    failureReason: firstError ? `${firstError.title}${firstError.message ? `: ${firstError.message}` : ""}` : undefined,
    occurredAt: new Date(Number(status.timestamp) * 1000),
    externalEventId: `${status.id}:${status.status}:${status.timestamp}`,
  };
}
