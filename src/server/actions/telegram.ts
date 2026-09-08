"use server";

/**
 * Telegram Server Actions, per docs/implementation-plan.md §5, rewritten for per-organization
 * bot credentials (replacing the single-global-bot-token design — see docs/review-report.md
 * C1 and docs/channel-adapters.md's "Known limitations" section for the history this
 * supersedes).
 *
 *   Server Action `getTelegramWebhookConfig` — returns this organization's own webhook URL
 *   (or `null` if no bot is connected yet) + setup instructions | Session+Role(Administrator+)
 *
 *   Server Action `registerTelegramWebhook` — an Administrator pastes their own bot's token
 *   (from @BotFather); this validates it (`getMe`), generates a per-organization webhook
 *   secret, encrypts `{ botToken, webhookSecret }`, creates/updates THIS org's `ChannelAccount`
 *   (keyed by the bot's own numeric id, `externalAccountId`), and registers the webhook with
 *   Telegram at this org's own per-account URL
 *   (`{APP_URL}/api/channels/telegram/webhook/{channelAccountId}`).
 *
 *   Server Action `getTelegramHealthStatus` — real per-organization health: decrypts this
 *   org's own bot token and calls `getMe` with it.
 *
 * ## The C1 guard, replaced
 * The old hard-block ("a second organization may never activate a Telegram ChannelAccount
 * while another org already has one") is gone — it was a band-aid for the fact that every
 * org shared one global bot token/webhook URL. Now that each org has genuinely distinct
 * credentials and a genuinely distinct webhook path, the real invariant is narrower and
 * enforced at the DB level: `ChannelAccount`'s `@@unique([channelType, externalAccountId])`
 * (prisma/schema.prisma) means the SAME bot (the same Telegram bot id) can never be
 * connected — active or not — to two different organizations at once. A second org trying
 * to paste the same bot token here hits that unique-constraint violation and gets a clear
 * `ConflictError`, no side effects.
 */
import { randomBytes } from "node:crypto";
import type { ChannelAccount } from "@prisma/client";
import { z } from "zod";
import { auth } from "../auth";
import { channelAdapterRegistry } from "../channels";
import type { TelegramAdapter } from "../channels/telegram/adapter";
import { encryptTelegramCredentials } from "../channels/telegram/credentials";
import { isUniqueConstraintViolation } from "../db";
import { env } from "../env";
import { ConflictError, NotConfiguredError, UpstreamAdapterError, ValidationError, toSafeActionError } from "../errors";
import { auditLogRepository } from "../repositories/auditLogRepository";
import { channelAccountRepository } from "../repositories/channelAccountRepository";
import { requireRole } from "../roles";

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

export interface TelegramWebhookConfig {
  telegramEnabled: boolean;
  connected: boolean;
  webhookUrl: string | null;
  displayName: string | null;
  instructions: string[];
}

function webhookUrlFor(channelAccountId: string): string {
  return new URL(`/api/channels/telegram/webhook/${channelAccountId}`, env.APP_URL).toString();
}

async function findOrgTelegramAccount(organizationId: string): Promise<ChannelAccount | null> {
  const accounts = await channelAccountRepository.listByChannelType(organizationId, "TELEGRAM");
  return accounts[0] ?? null;
}

export async function getTelegramWebhookConfig(): Promise<ActionResult<TelegramWebhookConfig>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const existing = await findOrgTelegramAccount(organizationId);

    return {
      ok: true,
      data: {
        telegramEnabled: env.TELEGRAM_ENABLED,
        connected: Boolean(existing?.encryptedCredentials),
        webhookUrl: existing ? webhookUrlFor(existing.id) : null,
        displayName: existing?.displayName ?? null,
        instructions: [
          "Create your own bot via @BotFather on Telegram and copy its bot token.",
          "Paste the bot token below and click \"Connect bot\" — this validates it with Telegram, generates a webhook secret unique to your organization, and registers the webhook automatically. No manual setWebhook call needed.",
          "An operator must set TELEGRAM_ENABLED=true for this deployment (and restart the app) before any organization can connect a bot.",
        ],
      },
    };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

export interface TelegramHealthStatus {
  enabled: boolean;
  connected: boolean;
  healthy: boolean;
  detail?: string;
}

export async function getTelegramHealthStatus(): Promise<ActionResult<TelegramHealthStatus>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    if (!env.TELEGRAM_ENABLED) {
      return { ok: true, data: { enabled: false, connected: false, healthy: false, detail: "TELEGRAM_ENABLED is false." } };
    }

    const existing = await findOrgTelegramAccount(organizationId);
    if (!existing || !existing.encryptedCredentials) {
      return {
        ok: true,
        data: { enabled: true, connected: false, healthy: false, detail: "No Telegram bot connected for this organization yet." },
      };
    }

    const adapter = channelAdapterRegistry.get("TELEGRAM") as TelegramAdapter | undefined;
    if (!adapter) {
      return { ok: true, data: { enabled: true, connected: true, healthy: false, detail: "Telegram adapter is not registered." } };
    }

    const health = await adapter.checkAccountHealth(existing);
    return { ok: true, data: { enabled: true, connected: true, ...health } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const connectTelegramBotSchema = z.object({
  botToken: z.string().min(1, "Bot token is required."),
});

export interface RegisterTelegramWebhookResult {
  description: string;
  webhookUrl: string;
  displayName: string;
}

/**
 * "Connect a Telegram bot" — an Administrator pastes their org's own bot token; this
 * validates it, generates+encrypts this org's credentials, creates/updates this org's
 * `ChannelAccount`, and registers the per-account webhook with Telegram.
 *
 * Ordering (deliberate — see the module doc comment): the bot token is validated via
 * `getMe` BEFORE any DB write. The `ChannelAccount` is then created/updated at
 * `PENDING_SETUP` (so its id exists to build the per-account webhook URL) and only flipped
 * to `ACTIVE` after Telegram's `setWebhook` call itself succeeds — if `setWebhook` fails,
 * the row is left at `PENDING_SETUP` with its (valid) credentials already stored, so a
 * retry re-uses the same `ChannelAccount` (the update path, not create) rather than needing
 * to re-enter the bot token.
 */
export async function registerTelegramWebhook(
  input: z.infer<typeof connectTelegramBotSchema>,
): Promise<ActionResult<RegisterTelegramWebhookResult>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    if (!env.TELEGRAM_ENABLED) {
      throw new NotConfiguredError("Telegram is not enabled for this deployment. Set TELEGRAM_ENABLED=true and restart the app first.");
    }

    const { botToken } = connectTelegramBotSchema.parse(input);

    const adapter = channelAdapterRegistry.get("TELEGRAM") as TelegramAdapter | undefined;
    if (!adapter) {
      throw new NotConfiguredError("Telegram adapter is not registered (TELEGRAM_ENABLED is false).");
    }

    const botInfo = await adapter.getBotInfo(botToken);
    if (!botInfo) {
      throw new ValidationError("Could not validate this bot token with Telegram — double-check it and try again.");
    }

    const displayName = botInfo.username ? `@${botInfo.username}` : botInfo.firstName;
    const externalAccountId = String(botInfo.id);
    const webhookSecret = randomBytes(32).toString("hex");
    const encryptedCredentials = encryptTelegramCredentials({ botToken, webhookSecret });

    const existing = await findOrgTelegramAccount(organizationId);

    let channelAccount: ChannelAccount;
    try {
      if (existing) {
        channelAccount = await channelAccountRepository.updateCredentials(organizationId, existing.id, {
          displayName,
          externalAccountId,
          encryptedCredentials,
          status: "PENDING_SETUP",
        });
      } else {
        channelAccount = await channelAccountRepository.create(organizationId, {
          channelType: "TELEGRAM",
          displayName,
          externalAccountId,
          encryptedCredentials,
          status: "PENDING_SETUP",
        });
      }
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError(
          "This Telegram bot is already connected to another organization. Each bot can only be connected to one organization at a time — create a new bot via @BotFather instead.",
          { organizationId, externalAccountId },
        );
      }
      throw error;
    }

    const webhookUrl = webhookUrlFor(channelAccount.id);
    const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret }),
    });
    const body = (await response.json()) as { ok: boolean; description?: string; error_code?: number };
    if (!response.ok || !body.ok) {
      throw new UpstreamAdapterError(body.description ?? "Telegram setWebhook call failed.", {
        status: body.error_code ?? response.status,
      });
    }

    await channelAccountRepository.updateStatus(organizationId, channelAccount.id, "ACTIVE");

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: existing ? "channel_account.credentials_rotated" : "channel_account.connected",
      entityType: "ChannelAccount",
      entityId: channelAccount.id,
      metadata: { channelType: "TELEGRAM", displayName },
    });

    return { ok: true, data: { description: body.description ?? "Webhook registered.", webhookUrl, displayName } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
