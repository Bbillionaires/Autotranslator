/**
 * `TelegramAdapter` — the one fully-functional `MessagingChannelAdapter` in this MVP, per
 * docs/implementation-plan.md §3.2/§6.3 and the Phase 6 task brief.
 *
 * - `sendMessage` / `sendRawMessage` / `answerCallbackQuery` / `healthCheck` / `getBotInfo`
 *   call the Telegram Bot API directly over plain `fetch` — no heavy SDK needed for the
 *   handful of methods this app uses.
 * - `validateWebhook` compares the `X-Telegram-Bot-Api-Secret-Token` header to
 *   `TELEGRAM_WEBHOOK_SECRET` using a constant-time comparison (`node:crypto`'s
 *   `timingSafeEqual`) to avoid leaking the secret via response-timing side channels.
 * - `parseInboundWebhook` delegates to the pure `normalizeTelegramUpdate` (./parse.ts).
 * - `getDeliveryStatus` always returns `null`: Telegram has no polling delivery-status API
 *   for regular bot messages, and this MVP wires no separate read-receipt webhook — a sent
 *   message is treated as `DELIVERED`-on-accept (`outboundService`'s `SENT` transition is
 *   the terminal tracked state for Telegram sends).
 */
import { timingSafeEqual } from "node:crypto";
import { env } from "../../env";
import { NotConfiguredError, UpstreamAdapterError } from "../../errors";
import type {
  DeliveryStatusUpdate,
  MessagingChannelAdapter,
  NormalizedInboundMessage,
  SendMessageInput,
  SendMessageResult,
} from "../types";
import { normalizeTelegramUpdate, type TelegramUpdate } from "./parse";

const TELEGRAM_API_BASE = "https://api.telegram.org";

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

interface TelegramMeResult {
  id: number;
  username?: string;
  first_name: string;
}

export interface TelegramBotInfo {
  id: number;
  username?: string;
  firstName: string;
}

function requireBotToken(): string {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new NotConfiguredError("TELEGRAM_BOT_TOKEN is not configured.");
  }
  return env.TELEGRAM_BOT_TOKEN;
}

/**
 * Constant-time string comparison. Falls back to comparing a buffer against itself (still
 * constant-time for that buffer's length) when lengths differ, since `timingSafeEqual`
 * requires equal-length inputs and an early `return false` on length mismatch would itself
 * leak the secret's length via timing.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export class TelegramAdapter implements MessagingChannelAdapter {
  readonly channelType = "TELEGRAM" as const;

  private async callTelegramApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const token = requireBotToken();
    const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // Network-level failure (DNS, timeout, connection reset, ...) — always transient.
      throw new UpstreamAdapterError(`Telegram API network error calling ${method}`, {
        transient: true,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    let parsed: TelegramApiResponse<T>;
    try {
      parsed = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      throw new UpstreamAdapterError(`Telegram API returned a non-JSON response for ${method}`, {
        status: response.status,
      });
    }

    if (!response.ok || !parsed.ok || parsed.result === undefined) {
      // `classifyAdapterFailure` (../../messaging/failureClassifier.ts) reads `detail.status`
      // as an HTTP-style code: 429 -> transient, >=500 -> transient, >=400 -> permanent.
      throw new UpstreamAdapterError(parsed.description ?? `Telegram API call to ${method} failed`, {
        status: parsed.error_code ?? response.status,
      });
    }

    return parsed.result;
  }

  /** Part of `MessagingChannelAdapter` — used by the outbound lifecycle (§3.6). */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const body: Record<string, unknown> = { chat_id: input.externalContactId, text: input.text };
    if (input.replyToExternalId) {
      const replyToMessageId = Number(input.replyToExternalId);
      if (!Number.isNaN(replyToMessageId)) {
        body.reply_to_message_id = replyToMessageId;
      }
    }
    const result = await this.callTelegramApi<{ message_id: number }>("sendMessage", body);
    return { externalMessageId: String(result.message_id), status: "SENT" };
  }

  /**
   * Not part of `MessagingChannelAdapter` — used by the bot-command flow (webhook route) for
   * replies (`/start`, `/help`, `/privacy`, the `/language` picker, and the post-selection
   * confirmation) that are never translated/stored as ordinary conversation `Message` rows
   * and so never go through the outbound lifecycle / `sendMessage`.
   */
  async sendRawMessage(
    chatId: string,
    text: string,
    options: { replyMarkup?: unknown } = {},
  ): Promise<{ messageId: string }> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (options.replyMarkup) {
      body.reply_markup = options.replyMarkup;
    }
    const result = await this.callTelegramApi<{ message_id: number }>("sendMessage", body);
    return { messageId: String(result.message_id) };
  }

  /** Acknowledges an inline-keyboard button press (clears the button's loading spinner). */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.callTelegramApi<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  async validateWebhook(req: Request): Promise<boolean> {
    const configured = env.TELEGRAM_WEBHOOK_SECRET;
    if (!configured) return false;
    const header = req.headers.get("x-telegram-bot-api-secret-token");
    if (!header) return false;
    return constantTimeEquals(header, configured);
  }

  async parseInboundWebhook(req: Request): Promise<NormalizedInboundMessage[]> {
    const update = (await req.json()) as TelegramUpdate;
    return normalizeTelegramUpdate(update);
  }

  /**
   * Always `null`: Telegram has no polling delivery-status API for regular bot messages, and
   * this MVP wires no separate read-receipt webhook. See the module-level doc comment.
   */
  async getDeliveryStatus(): Promise<DeliveryStatusUpdate | null> {
    return null;
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      const result = await this.callTelegramApi<TelegramMeResult>("getMe", {});
      return { healthy: true, detail: result.username ? `@${result.username}` : result.first_name };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  /**
   * Resolves the bot's own Telegram user id/username via `getMe`. Used by the "register
   * webhook now" Server Action (`src/server/actions/telegram.ts`) to populate
   * `ChannelAccount.externalAccountId`/`displayName` at connect time — NOT used on the
   * per-request webhook hot path (see the webhook route's doc comment for why).
   */
  async getBotInfo(): Promise<TelegramBotInfo | null> {
    try {
      const result = await this.callTelegramApi<TelegramMeResult>("getMe", {});
      return { id: result.id, username: result.username, firstName: result.first_name };
    } catch {
      return null;
    }
  }
}

export const telegramAdapter = new TelegramAdapter();
