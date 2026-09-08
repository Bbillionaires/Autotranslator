/**
 * `POST /api/channels/telegram/webhook/:channelAccountId` — inbound Telegram updates, per
 * docs/implementation-plan.md §3.5/§5/§6.3, rewritten for per-organization bot credentials.
 *
 * This REPLACES the old global `POST /api/channels/telegram/webhook` route (removed — see
 * docs/channel-adapters.md and the Builder task's per-org-credentials rewrite): that route
 * resolved "the ChannelAccount" by picking the sole ACTIVE Telegram row across the WHOLE
 * deployment, which only worked because every organization shared one global bot
 * token/webhook URL. Now every organization has its own bot and its own webhook URL — the
 * URL itself names the `ChannelAccount` this delivery belongs to, so there is no more
 * "which org is this for?" guessing game and no more single-tenant restriction.
 *
 * Request lifecycle:
 *  1. Resolve the `ChannelAccount` named by the URL's `:channelAccountId` path segment
 *     (`channelAccountRepository.findById` — cross-org by design, since the URL itself is
 *     the only thing identifying which org this is; the request is trusted only after step
 *     2 verifies it against THAT account's own secret). Unknown id, wrong channel type, or
 *     not `ACTIVE` -> `404` (deliberately vague — this endpoint is unauthenticated, and a
 *     `404` doesn't tell a prober whether the id exists but is disabled vs. never existed).
 *  2. Decrypt that account's own stored `{ botToken, webhookSecret }` and validate
 *     `X-Telegram-Bot-Api-Secret-Token` against THIS account's own `webhookSecret`
 *     (constant-time compare) — never a global secret. Invalid/missing -> `401`, no DB
 *     write.
 *  3. Bot commands (`/start`, `/language`, `/help`, `/privacy`) and inline-keyboard
 *     `callback_query` (the `/language` picker's selection) are intercepted here, BEFORE
 *     `processInboundMessage()` — they are replied to directly via the adapter (using this
 *     account's own bot token) and never translated/stored as ordinary chat `Message` rows.
 *  4. Everything else is normalized (`normalizeTelegramUpdate`) and handed to
 *     `processInboundMessage()` (Phase 5), which is idempotent on
 *     `(channelAccountId, externalMessageId)` — a replayed webhook short-circuits to the
 *     existing `Message` row instead of erroring or double-processing.
 *
 * Always returns `200` once past validation (even on "ignored" cases) so Telegram doesn't
 * retry-storm a message we've deliberately decided not to process further.
 */
import type { ChannelAccount } from "@prisma/client";
import { channelAdapterRegistry } from "@/server/channels";
import { constantTimeEquals, type TelegramAdapter } from "@/server/channels/telegram/adapter";
import {
  buildLanguageKeyboard,
  findSupportedLanguage,
  helpText,
  isBotCommandText,
  languageConfirmationText,
  languagePromptText,
  LANGUAGE_CALLBACK_PREFIX,
  parseBotCommand,
  privacyText,
  startGreetingText,
  unknownCommandText,
} from "@/server/channels/telegram/commands";
import { decryptTelegramCredentials } from "@/server/channels/telegram/credentials";
import { normalizeTelegramUpdate, type TelegramCallbackQuery, type TelegramMessage, type TelegramUpdate } from "@/server/channels/telegram/parse";
import { handleRouteError, ValidationError } from "@/server/errors";
import { withContext } from "@/server/logger";
import { processInboundMessage } from "@/server/messaging/inboundService";
import { resolveOrCreateContactAndConversation } from "@/server/messaging/contactResolution";
import { getClientIp, rateLimitedResponse, webhookRateLimiter } from "@/server/rateLimit";
import { channelAccountRepository } from "@/server/repositories/channelAccountRepository";
import { contactRepository } from "@/server/repositories/contactRepository";

async function resolveChannelAccount(channelAccountId: string): Promise<ChannelAccount | null> {
  const channelAccount = await channelAccountRepository.findById(channelAccountId);
  if (!channelAccount || channelAccount.channelType !== "TELEGRAM" || channelAccount.status !== "ACTIVE") {
    return null;
  }
  return channelAccount;
}

async function handleBotCommand(
  adapter: TelegramAdapter,
  botToken: string,
  channelAccount: ChannelAccount,
  message: TelegramMessage,
): Promise<void> {
  const chatId = String(message.chat.id);
  const { command } = parseBotCommand(message.text ?? "");

  // Resolve/create the Contact so command usage (even before any regular chat message)
  // links to the same Contact a later inbound message would match.
  await resolveOrCreateContactAndConversation(channelAccount.organizationId, channelAccount, {
    externalContactId: chatId,
    externalUsername: message.from?.username,
  });

  switch (command) {
    case "start":
      await adapter.sendRawMessage(botToken, chatId, startGreetingText());
      return;
    case "language":
      await adapter.sendRawMessage(botToken, chatId, languagePromptText(), { replyMarkup: buildLanguageKeyboard() });
      return;
    case "help":
      await adapter.sendRawMessage(botToken, chatId, helpText());
      return;
    case "privacy":
      await adapter.sendRawMessage(botToken, chatId, privacyText());
      return;
    default:
      await adapter.sendRawMessage(botToken, chatId, unknownCommandText());
  }
}

async function handleCallbackQuery(
  adapter: TelegramAdapter,
  botToken: string,
  channelAccount: ChannelAccount,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const chatId = callbackQuery.message ? String(callbackQuery.message.chat.id) : undefined;
  const data = callbackQuery.data ?? "";

  if (!chatId || !data.startsWith(LANGUAGE_CALLBACK_PREFIX)) {
    await adapter.answerCallbackQuery(botToken, callbackQuery.id);
    return;
  }

  const code = data.slice(LANGUAGE_CALLBACK_PREFIX.length);
  const language = findSupportedLanguage(code);
  if (!language) {
    await adapter.answerCallbackQuery(botToken, callbackQuery.id, "Unrecognized language.");
    return;
  }

  const { contact } = await resolveOrCreateContactAndConversation(channelAccount.organizationId, channelAccount, {
    externalContactId: chatId,
    externalUsername: callbackQuery.from.username,
  });
  await contactRepository.updatePreferredLanguage(channelAccount.organizationId, contact.id, language.code);

  await adapter.answerCallbackQuery(botToken, callbackQuery.id, languageConfirmationText(language.label));
  await adapter.sendRawMessage(botToken, chatId, languageConfirmationText(language.label));
}

export async function POST(req: Request, { params }: { params: Promise<{ channelAccountId: string }> }): Promise<Response> {
  const adapter = channelAdapterRegistry.get("TELEGRAM") as TelegramAdapter | undefined;
  if (!adapter) {
    // Telegram not enabled in this deployment — inert, matching the WhatsApp adapter's
    // "disabled -> 404/no-op" precedent (§3.2).
    return Response.json({ error: "Telegram channel is not enabled." }, { status: 404 });
  }

  // Rate-limited per-IP, before any signature validation or DB work — a flood (valid or
  // invalid signature) shouldn't get further than this.
  const rateLimit = webhookRateLimiter.check(getClientIp(req));
  if (!rateLimit.allowed) {
    return rateLimitedResponse();
  }

  const { channelAccountId } = await params;
  const channelAccount = await resolveChannelAccount(channelAccountId);
  if (!channelAccount) {
    // Deliberately vague (404, not "channel account disabled" vs "never existed") — this
    // endpoint is unauthenticated, no need to hand a prober more signal than necessary.
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  let botToken: string;
  let webhookSecret: string;
  try {
    ({ botToken, webhookSecret } = decryptTelegramCredentials(channelAccount));
  } catch (error) {
    withContext({ organizationId: channelAccount.organizationId, channelAccountId: channelAccount.id }).error(
      { err: error },
      "telegram_webhook_credentials_undecryptable",
    );
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const header = req.headers.get("x-telegram-bot-api-secret-token");
  if (!header || !constantTimeEquals(header, webhookSecret)) {
    withContext({ organizationId: channelAccount.organizationId, channelAccountId: channelAccount.id }).warn(
      "Telegram webhook: invalid or missing X-Telegram-Bot-Api-Secret-Token header",
    );
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return handleRouteError(new ValidationError("Malformed Telegram update payload."));
  }

  const log = withContext({ organizationId: channelAccount.organizationId, channelAccountId: channelAccount.id });

  try {
    if (update.callback_query) {
      await handleCallbackQuery(adapter, botToken, channelAccount, update.callback_query);
      return Response.json({ ok: true }, { status: 200 });
    }

    const rawMessage = update.message ?? update.edited_message;
    if (rawMessage?.text && isBotCommandText(rawMessage.text)) {
      await handleBotCommand(adapter, botToken, channelAccount, rawMessage);
      return Response.json({ ok: true }, { status: 200 });
    }

    const normalized = normalizeTelegramUpdate(update);
    for (const message of normalized) {
      const result = await processInboundMessage(message, channelAccount);
      if (result.wasDuplicate) {
        log.info({ externalMessageId: message.externalMessageId }, "duplicate_webhook_ignored");
      }
    }

    return Response.json({ ok: true }, { status: 200 });
  } catch (error) {
    return handleRouteError(error, { updateId: update.update_id, channelAccountId: channelAccount.id });
  }
}
