/**
 * `POST /api/channels/telegram/webhook` — inbound Telegram updates, per
 * docs/implementation-plan.md §3.5/§5/§6.3 and the Phase 6 task brief.
 *
 * Request lifecycle:
 *  1. Validate: `adapter.validateWebhook(req)` compares `X-Telegram-Bot-Api-Secret-Token`
 *     against `TELEGRAM_WEBHOOK_SECRET`. Invalid/missing -> `401`, no DB write.
 *  2. Resolve the `ChannelAccount` this webhook belongs to. This MVP supports exactly one
 *     global Telegram bot token (`env.TELEGRAM_BOT_TOKEN`), so resolution is simply "the
 *     sole ACTIVE Telegram ChannelAccount across the whole deployment" — deliberately NOT a
 *     `getMe` network round-trip on every webhook delivery. Real multi-org Telegram support
 *     (distinct bot tokens per organization) is a documented post-MVP gap; see
 *     docs/channel-adapters.md.
 *
 *     C1 fix (docs/review-report.md): `registerTelegramWebhook`
 *     (`src/server/actions/telegram.ts`) now hard-blocks a second organization from ever
 *     creating a second ACTIVE Telegram ChannelAccount, so under normal operation exactly
 *     zero or one such row exists across every organization. `resolveTelegramChannelAccount`
 *     makes that invariant explicit and SAFE rather than assumed: if it ever finds MORE
 *     THAN ONE active row (which should be impossible given the guard above, but could still
 *     happen via direct DB access, a bug, or a future regression), it logs an error and
 *     rejects the request instead of silently picking one — failing loud, not silently
 *     routing a message to the wrong organization.
 *  3. Bot commands (`/start`, `/language`, `/help`, `/privacy`) and inline-keyboard
 *     `callback_query` (the `/language` picker's selection) are intercepted here, BEFORE
 *     `processInboundMessage()` — they are replied to directly via the adapter and never
 *     translated/stored as ordinary chat `Message` rows, per the Phase 6 task brief.
 *  4. Everything else is normalized (`adapter.parseInboundWebhook`) and handed to
 *     `processInboundMessage()` (Phase 5), which is idempotent on
 *     `(channelAccountId, externalMessageId)` — a replayed webhook short-circuits to the
 *     existing `Message` row instead of erroring or double-processing.
 *
 * Always returns `200` once past validation (even on "ignored" cases) so Telegram doesn't
 * retry-storm a message we've deliberately decided not to process further.
 */
import { channelAdapterRegistry } from "@/server/channels";
import type { TelegramAdapter } from "@/server/channels/telegram/adapter";
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
import { normalizeTelegramUpdate, type TelegramCallbackQuery, type TelegramMessage, type TelegramUpdate } from "@/server/channels/telegram/parse";
import { ConflictError, handleRouteError, ValidationError } from "@/server/errors";
import { withContext } from "@/server/logger";
import { processInboundMessage } from "@/server/messaging/inboundService";
import { resolveOrCreateContactAndConversation } from "@/server/messaging/contactResolution";
import { getClientIp, rateLimitedResponse, webhookRateLimiter } from "@/server/rateLimit";
import { channelAccountRepository } from "@/server/repositories/channelAccountRepository";
import { contactRepository } from "@/server/repositories/contactRepository";
import type { ChannelAccount } from "@prisma/client";

/**
 * Resolves the sole ACTIVE Telegram `ChannelAccount` across the whole deployment (see the
 * module doc comment's step 2). Throws `ConflictError` — logged loudly first — if more than
 * one is ever found, instead of silently picking one (the C1 fix: routing an inbound
 * message to the wrong organization is a real data-leakage bug, not an acceptable
 * fallback).
 */
async function resolveTelegramChannelAccount(): Promise<ChannelAccount | null> {
  const activeAccounts = await channelAccountRepository.listAllActiveByChannelType("TELEGRAM");
  if (activeAccounts.length === 0) {
    return null;
  }
  if (activeAccounts.length > 1) {
    withContext({}).error(
      {
        count: activeAccounts.length,
        organizationIds: activeAccounts.map((account) => account.organizationId),
      },
      "telegram_webhook_multiple_active_channel_accounts — single-tenant invariant violated, refusing to guess which organization owns this delivery",
    );
    throw new ConflictError(
      "Telegram inbound routing is unsafe: more than one organization has an ACTIVE Telegram channel account in this single-global-bot-token deployment.",
    );
  }
  return activeAccounts[0];
}

async function handleBotCommand(adapter: TelegramAdapter, channelAccount: ChannelAccount, message: TelegramMessage): Promise<void> {
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
      await adapter.sendRawMessage(chatId, startGreetingText());
      return;
    case "language":
      await adapter.sendRawMessage(chatId, languagePromptText(), { replyMarkup: buildLanguageKeyboard() });
      return;
    case "help":
      await adapter.sendRawMessage(chatId, helpText());
      return;
    case "privacy":
      await adapter.sendRawMessage(chatId, privacyText());
      return;
    default:
      await adapter.sendRawMessage(chatId, unknownCommandText());
  }
}

async function handleCallbackQuery(
  adapter: TelegramAdapter,
  channelAccount: ChannelAccount,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const chatId = callbackQuery.message ? String(callbackQuery.message.chat.id) : undefined;
  const data = callbackQuery.data ?? "";

  if (!chatId || !data.startsWith(LANGUAGE_CALLBACK_PREFIX)) {
    await adapter.answerCallbackQuery(callbackQuery.id);
    return;
  }

  const code = data.slice(LANGUAGE_CALLBACK_PREFIX.length);
  const language = findSupportedLanguage(code);
  if (!language) {
    await adapter.answerCallbackQuery(callbackQuery.id, "Unrecognized language.");
    return;
  }

  const { contact } = await resolveOrCreateContactAndConversation(channelAccount.organizationId, channelAccount, {
    externalContactId: chatId,
    externalUsername: callbackQuery.from.username,
  });
  await contactRepository.updatePreferredLanguage(channelAccount.organizationId, contact.id, language.code);

  await adapter.answerCallbackQuery(callbackQuery.id, languageConfirmationText(language.label));
  await adapter.sendRawMessage(chatId, languageConfirmationText(language.label));
}

export async function POST(req: Request): Promise<Response> {
  const adapter = channelAdapterRegistry.get("TELEGRAM") as TelegramAdapter | undefined;
  if (!adapter) {
    // Telegram not enabled in this deployment — inert, matching the WhatsApp adapter's
    // "disabled -> 404/no-op" precedent (§3.2).
    return Response.json({ error: "Telegram channel is not enabled." }, { status: 404 });
  }

  // H2 fix (docs/review-report.md): rate-limited per-IP, before any signature validation
  // or DB work — a flood (valid or invalid signature) shouldn't get further than this.
  const rateLimit = webhookRateLimiter.check(getClientIp(req));
  if (!rateLimit.allowed) {
    return rateLimitedResponse();
  }

  const isValid = await adapter.validateWebhook(req);
  if (!isValid) {
    withContext({}).warn("Telegram webhook: invalid or missing X-Telegram-Bot-Api-Secret-Token header");
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return handleRouteError(new ValidationError("Malformed Telegram update payload."));
  }

  try {
    const channelAccount = await resolveTelegramChannelAccount();
    if (!channelAccount) {
      // Configuration gap (bot enabled but no ChannelAccount connected yet) — not the
      // sender's fault, so still 200 (avoid a Telegram retry storm) but log loudly.
      withContext({}).error({ updateId: update.update_id }, "telegram_webhook_no_channel_account");
      return Response.json({ ok: true, ignored: "no_channel_account" }, { status: 200 });
    }

    const log = withContext({ organizationId: channelAccount.organizationId, channelAccountId: channelAccount.id });

    if (update.callback_query) {
      await handleCallbackQuery(adapter, channelAccount, update.callback_query);
      return Response.json({ ok: true }, { status: 200 });
    }

    const rawMessage = update.message ?? update.edited_message;
    if (rawMessage?.text && isBotCommandText(rawMessage.text)) {
      await handleBotCommand(adapter, channelAccount, rawMessage);
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
    return handleRouteError(error, { updateId: update.update_id });
  }
}
