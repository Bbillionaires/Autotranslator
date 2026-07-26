"use server";

/**
 * Telegram Server Actions, per docs/implementation-plan.md §5:
 *
 *   Server Action `getTelegramWebhookConfig` — returns the webhook URL + secret-setup
 *   instructions for admin to register with BotFather/`setWebhook` | Session+Role(Administrator+)
 *   | read-only helper, no external call unless "register" is explicitly clicked.
 *
 * `registerTelegramWebhook` is the "if you have time" nice-to-have the Phase 6 task brief
 * called out: it actually calls Telegram's `setWebhook` API (instead of leaving that as a
 * manual copy-paste step) and, on success, ensures a `ChannelAccount` exists for this org so
 * the webhook route's resolution logic (see the webhook route's doc comment) has something
 * to find. `getTelegramHealthStatus` backs the minimal Settings UI section (deliverable #12)
 * without the client component needing to fetch `/api/channels/telegram/health` directly.
 */
import { auth } from "../auth";
import { channelAdapterRegistry } from "../channels";
import type { TelegramAdapter } from "../channels/telegram/adapter";
import { env } from "../env";
import { ConflictError, NotConfiguredError, UpstreamAdapterError, toSafeActionError } from "../errors";
import { auditLogRepository } from "../repositories/auditLogRepository";
import { channelAccountRepository } from "../repositories/channelAccountRepository";
import { requireRole } from "../roles";

export interface TelegramWebhookConfig {
  webhookUrl: string;
  secretConfigured: boolean;
  botTokenConfigured: boolean;
  telegramEnabled: boolean;
  instructions: string[];
}

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

function webhookUrl(): string {
  return new URL("/api/channels/telegram/webhook", env.APP_URL).toString();
}

export async function getTelegramWebhookConfig(): Promise<ActionResult<TelegramWebhookConfig>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");

    const url = webhookUrl();
    return {
      ok: true,
      data: {
        webhookUrl: url,
        secretConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
        botTokenConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
        telegramEnabled: env.TELEGRAM_ENABLED,
        instructions: [
          "Create a bot via @BotFather on Telegram and copy the bot token into TELEGRAM_BOT_TOKEN.",
          "Choose a random secret string and set it as TELEGRAM_WEBHOOK_SECRET.",
          `Register the webhook: call https://api.telegram.org/bot<token>/setWebhook with body {"url": "${url}", "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"} — or use "Register webhook now" below.`,
          "Set TELEGRAM_ENABLED=true and restart the app so the adapter is registered.",
        ],
      },
    };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

export interface TelegramHealthStatus {
  enabled: boolean;
  healthy: boolean;
  detail?: string;
}

export async function getTelegramHealthStatus(): Promise<ActionResult<TelegramHealthStatus>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");

    const adapter = channelAdapterRegistry.get("TELEGRAM");
    if (!adapter) {
      return { ok: true, data: { enabled: false, healthy: false, detail: "TELEGRAM_ENABLED is false." } };
    }
    const health = await adapter.healthCheck();
    return { ok: true, data: { enabled: true, ...health } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

export interface RegisterTelegramWebhookResult {
  description: string;
}

/**
 * Calls Telegram's `setWebhook` directly with the configured secret token, then ensures an
 * ACTIVE `ChannelAccount` of type TELEGRAM exists for the caller's org (creating one, keyed
 * by the bot's own id/username via `getMe`, if none exists yet). This is the "connect a
 * Telegram bot" action the minimal Settings UI section exposes.
 *
 * ## C1 fix — single-tenant-per-deployment guard (docs/review-report.md)
 * This deployment has exactly one global `TELEGRAM_BOT_TOKEN`/webhook URL, so at most one
 * organization can safely own the ACTIVE Telegram `ChannelAccount` the inbound webhook
 * route resolves against (see that route's `resolveTelegramChannelAccount`). Before ever
 * creating a NEW `ChannelAccount` for this org, we check — across ALL organizations, not
 * just the caller's own — whether a DIFFERENT organization already has an ACTIVE Telegram
 * `ChannelAccount`. If so, this call is hard-rejected with a `ConflictError` BEFORE calling
 * Telegram's API at all (no side effects, no wasted network call, immediate clear
 * feedback). This is deliberately NOT scoped to "only when a new row would be created" via
 * a race-prone check-then-act against the DB unique constraint — `ChannelAccount` has no
 * unique constraint on `(channelType, status)` globally, so this is an application-level
 * guard, not a DB-level one; acceptable because registration is a low-frequency,
 * admin-only, session-authenticated action (not a hot path needing DB-level atomicity).
 */
export async function registerTelegramWebhook(): Promise<ActionResult<RegisterTelegramWebhookResult>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");

    if (!env.TELEGRAM_ENABLED) {
      throw new NotConfiguredError("Telegram is not enabled. Set TELEGRAM_ENABLED=true and restart the app first.");
    }
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
      throw new NotConfiguredError("TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must both be set.");
    }

    const organizationId = session!.user.organizationId;
    const existing = await channelAccountRepository.listByChannelType(organizationId, "TELEGRAM");
    const willCreateNewAccount = existing.length === 0;

    if (willCreateNewAccount) {
      const conflictingAccount = await channelAccountRepository.findFirstActiveByChannelTypeInOtherOrg(
        "TELEGRAM",
        organizationId,
      );
      if (conflictingAccount) {
        throw new ConflictError(
          "This deployment's Telegram bot is already connected to another organization. Multi-org Telegram requires per-org bot tokens, not yet supported.",
          { organizationId, conflictingOrganizationId: conflictingAccount.organizationId },
        );
      }
    }

    const url = webhookUrl();
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, secret_token: env.TELEGRAM_WEBHOOK_SECRET }),
    });
    const body = (await response.json()) as { ok: boolean; description?: string; error_code?: number };
    if (!response.ok || !body.ok) {
      throw new UpstreamAdapterError(body.description ?? "Telegram setWebhook call failed.", {
        status: body.error_code ?? response.status,
      });
    }

    if (willCreateNewAccount) {
      const adapter = channelAdapterRegistry.get("TELEGRAM") as TelegramAdapter | undefined;
      const botInfo = adapter ? await adapter.getBotInfo() : null;
      const channelAccount = await channelAccountRepository.create(organizationId, {
        channelType: "TELEGRAM",
        displayName: botInfo?.username ? `@${botInfo.username}` : "Telegram Bot",
        externalAccountId: botInfo ? String(botInfo.id) : undefined,
        status: "ACTIVE",
      });

      // M1: channel account connect is an audited mutation per §6.8.
      await auditLogRepository.record({
        organizationId,
        userId: session!.user.id,
        action: "channel_account.connected",
        entityType: "ChannelAccount",
        entityId: channelAccount.id,
        metadata: { channelType: "TELEGRAM", displayName: channelAccount.displayName },
      });
    }

    return { ok: true, data: { description: body.description ?? "Webhook registered." } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
