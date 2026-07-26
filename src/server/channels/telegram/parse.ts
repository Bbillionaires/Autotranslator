/**
 * Telegram `Update` payload types and pure normalization, per
 * docs/implementation-plan.md §3.2/§6.3. Only the subset of the Bot API's `Update` shape
 * this app actually uses is modeled here (message, edited_message, callback_query) — see
 * https://core.telegram.org/bots/api#update for the full shape.
 *
 * Kept dependency-free (no Prisma/env/logging) so it's trivially unit-testable against
 * fixture payloads.
 */
import type { NormalizedInboundMessage } from "../types";

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  /** Unix seconds — the message's original send time. */
  date: number;
  /** Unix seconds — present (and updated) only on `edited_message`. */
  edit_date?: number;
  reply_to_message?: { message_id: number };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/**
 * Normalizes a single Telegram message (`message` or `edited_message`) into a
 * `NormalizedInboundMessage`, or `null` for a message with no text (e.g. a bare photo/sticker
 * — out of scope for this MVP's text-translation pipeline).
 *
 * `isEdited` disambiguates the derived `externalMessageId`: Telegram reuses the same
 * `message_id` for `edited_message` as the original `message`, which would otherwise collide
 * with the original message's `(channelAccountId, externalMessageId)` idempotency key and
 * silently collapse an edit onto the original inbound Message row instead of producing a
 * distinct one. Suffixing with `edit_date` (falling back to `date`) keeps each distinct edit
 * addressable as its own Message.
 */
function normalizeTelegramMessage(message: TelegramMessage, isEdited: boolean): NormalizedInboundMessage | null {
  if (!message.text) return null;

  const externalMessageId = isEdited
    ? `${message.message_id}:edited:${message.edit_date ?? message.date}`
    : String(message.message_id);

  return {
    externalContactId: String(message.chat.id),
    externalUsername: message.from?.username,
    externalMessageId,
    externalReplyToId: message.reply_to_message ? String(message.reply_to_message.message_id) : undefined,
    text: message.text,
    sentAt: new Date(message.date * 1000),
    raw: message,
  };
}

/**
 * Normalizes a full Telegram `Update` into zero or one `NormalizedInboundMessage` (Telegram
 * never populates both `message` and `edited_message` on the same update). `raw` is set to
 * the *entire* update (not just the inner message) so `MessageEvent.payload` retains full
 * audit context, per `NormalizedInboundMessage.raw`'s contract.
 */
export function normalizeTelegramUpdate(update: TelegramUpdate): NormalizedInboundMessage[] {
  const results: NormalizedInboundMessage[] = [];

  if (update.message) {
    const normalized = normalizeTelegramMessage(update.message, false);
    if (normalized) results.push({ ...normalized, raw: update });
  }

  if (update.edited_message) {
    const normalized = normalizeTelegramMessage(update.edited_message, true);
    if (normalized) results.push({ ...normalized, raw: update });
  }

  return results;
}
