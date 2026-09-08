/**
 * `TelegramAdapter` — the one fully-functional `MessagingChannelAdapter` in this MVP, per
 * docs/implementation-plan.md §3.2/§6.3.
 *
 * ## Per-organization bot credentials
 * Each organization connects its OWN Telegram bot (its own `TELEGRAM_BOT_TOKEN`-equivalent,
 * pasted from @BotFather in Settings) rather than this deployment sharing one global bot
 * token — see `docs/channel-adapters.md` and `src/server/actions/telegram.ts`. Every method
 * here that calls the Telegram Bot API therefore needs an explicit bot token: `sendMessage`
 * (part of `MessagingChannelAdapter`) receives it via `input.channelAccount` (decrypted with
 * `decryptTelegramCredentials`); every other method (`sendRawMessage`,
 * `answerCallbackQuery`, `getBotInfo`) takes the already-resolved `botToken` directly, since
 * their callers (the per-account webhook route, the "connect a bot" Server Action) already
 * have the `ChannelAccount`/credentials in hand and there is no reason to decrypt twice.
 *
 * - `parseInboundWebhook` delegates to the pure `normalizeTelegramUpdate` (./parse.ts) — no
 *   credential needed, it's pure payload parsing.
 * - `getDeliveryStatus` always returns `null`: Telegram has no polling delivery-status API
 *   for regular bot messages, and this MVP wires no separate read-receipt webhook — a sent
 *   message is treated as `DELIVERED`-on-accept (`outboundService`'s `SENT` transition is
 *   the terminal tracked state for Telegram sends).
 * - `healthCheck()` (the parameterless, interface-required method) can only report "the
 *   adapter is registered" — it has no single global bot to check anymore. Real,
 *   meaningful per-organization health lives in `checkAccountHealth`, called by
 *   `getTelegramHealthStatus` (`src/server/actions/telegram.ts`) with that org's own
 *   decrypted bot token.
 */
import { timingSafeEqual } from "node:crypto";
import type { ChannelAccount } from "@prisma/client";
import { UpstreamAdapterError } from "../../errors";
import type {
  DeliveryStatusUpdate,
  MessagingChannelAdapter,
  NormalizedInboundMessage,
  SendMessageInput,
  SendMessageResult,
} from "../types";
import { decryptTelegramCredentials } from "./credentials";
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

/**
 * Constant-time string comparison. Falls back to comparing a buffer against itself (still
 * constant-time for that buffer's length) when lengths differ, since `timingSafeEqual`
 * requires equal-length inputs and an early `return false` on length mismatch would itself
 * leak the secret's length via timing. Exported so the per-account webhook route (which now
 * owns the secret-token comparison, keyed to each account's own decrypted webhook secret
 * rather than a global one) reuses the exact same helper instead of duplicating it.
 */
export function constantTimeEquals(a: string, b: string): boolean {
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

  private async callTelegramApi<T>(botToken: string, method: string, body: Record<string, unknown>): Promise<T> {
    const url = `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;

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

  /**
   * Part of `MessagingChannelAdapter` — used by the outbound lifecycle (§3.6). Decrypts
   * this specific org's bot token from `input.channelAccount.encryptedCredentials` — never
   * a global env var.
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const { botToken } = decryptTelegramCredentials(input.channelAccount);
    const body: Record<string, unknown> = { chat_id: input.externalContactId, text: input.text };
    if (input.replyToExternalId) {
      const replyToMessageId = Number(input.replyToExternalId);
      if (!Number.isNaN(replyToMessageId)) {
        body.reply_to_message_id = replyToMessageId;
      }
    }
    const result = await this.callTelegramApi<{ message_id: number }>(botToken, "sendMessage", body);
    return { externalMessageId: String(result.message_id), status: "SENT" };
  }

  /**
   * Not part of `MessagingChannelAdapter` — used by the bot-command flow (webhook route) for
   * replies (`/start`, `/help`, `/privacy`, the `/language` picker, and the post-selection
   * confirmation) that are never translated/stored as ordinary conversation `Message` rows
   * and so never go through the outbound lifecycle / `sendMessage`. Takes `botToken`
   * explicitly since the webhook route has already resolved+decrypted the `ChannelAccount`
   * for this request.
   */
  async sendRawMessage(
    botToken: string,
    chatId: string,
    text: string,
    options: { replyMarkup?: unknown } = {},
  ): Promise<{ messageId: string }> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (options.replyMarkup) {
      body.reply_markup = options.replyMarkup;
    }
    const result = await this.callTelegramApi<{ message_id: number }>(botToken, "sendMessage", body);
    return { messageId: String(result.message_id) };
  }

  /** Acknowledges an inline-keyboard button press (clears the button's loading spinner). */
  async answerCallbackQuery(botToken: string, callbackQueryId: string, text?: string): Promise<void> {
    await this.callTelegramApi<boolean>(botToken, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
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

  /**
   * Interface-required, parameterless — there is no single global bot to check any more
   * (each org has its own), so this can only ever report that the adapter is registered.
   * Real per-organization health is `checkAccountHealth` below.
   */
  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: true, detail: "Telegram adapter registered. Connect a bot in Settings to check its own health." };
  }

  /**
   * Resolves a bot's own Telegram user id/username via `getMe`, given an explicit token.
   * Used by the "connect a bot" Server Action (`src/server/actions/telegram.ts`) to validate
   * a pasted bot token and populate `ChannelAccount.externalAccountId`/`displayName` at
   * connect time.
   */
  async getBotInfo(botToken: string): Promise<TelegramBotInfo | null> {
    try {
      const result = await this.callTelegramApi<TelegramMeResult>(botToken, "getMe", {});
      return { id: result.id, username: result.username, firstName: result.first_name };
    } catch {
      return null;
    }
  }

  /**
   * Real per-organization connection health: decrypts `channelAccount`'s own bot token and
   * calls `getMe` against it. Distinct from the parameterless `healthCheck()` above (which
   * the `MessagingChannelAdapter` interface requires but which has no per-org concept to
   * check against).
   */
  async checkAccountHealth(channelAccount: ChannelAccount): Promise<{ healthy: boolean; detail?: string }> {
    try {
      const { botToken } = decryptTelegramCredentials(channelAccount);
      const result = await this.callTelegramApi<TelegramMeResult>(botToken, "getMe", {});
      return { healthy: true, detail: result.username ? `@${result.username}` : result.first_name };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : "Unknown error" };
    }
  }
}

export const telegramAdapter = new TelegramAdapter();
