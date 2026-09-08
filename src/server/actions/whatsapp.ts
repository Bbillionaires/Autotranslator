"use server";

/**
 * WhatsApp Server Actions, rewritten for per-organization credentials (replacing the
 * global-`WHATSAPP_*`-env-var design — see docs/channel-adapters.md and the Builder task's
 * per-org-credentials rewrite).
 *
 *   Server Action `connectWhatsAppAccount` — an Administrator pastes their org's own
 *   WhatsApp Cloud API credentials (access token, phone number id, business account id, app
 *   secret, an operator-chosen verify token); this runs a lightweight health check against
 *   the Graph API BEFORE saving (so a typo'd token/id is caught immediately), then encrypts
 *   and creates/updates this org's `ChannelAccount` (keyed by `phoneNumberId`, the WhatsApp
 *   analogue of Telegram's bot id).
 *
 *   Server Action `getWhatsAppHealthStatus` — real per-organization health: decrypts this
 *   org's own credentials and fetches that phone number's own info from the Graph API.
 *
 * `WHATSAPP_ENABLED` remains a global feature flag (gates whether the adapter/routes exist
 * at all) — the credentials themselves are per-org now, not global env vars.
 */
import type { ChannelAccount } from "@prisma/client";
import { z } from "zod";
import { auth } from "../auth";
import { channelAdapterRegistry } from "../channels";
import type { WhatsAppAdapter } from "../channels/whatsapp/adapter";
import { encryptWhatsAppCredentials } from "../channels/whatsapp/credentials";
import { isUniqueConstraintViolation } from "../db";
import { env } from "../env";
import { ConflictError, NotConfiguredError, ValidationError, toSafeActionError } from "../errors";
import { auditLogRepository } from "../repositories/auditLogRepository";
import { channelAccountRepository } from "../repositories/channelAccountRepository";
import { requireRole } from "../roles";

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

function webhookUrlFor(channelAccountId: string): string {
  return new URL(`/api/channels/whatsapp/webhook/${channelAccountId}`, env.APP_URL).toString();
}

async function findOrgWhatsAppAccount(organizationId: string): Promise<ChannelAccount | null> {
  const accounts = await channelAccountRepository.listByChannelType(organizationId, "WHATSAPP");
  return accounts[0] ?? null;
}

export interface WhatsAppWebhookConfig {
  whatsAppEnabled: boolean;
  connected: boolean;
  webhookUrl: string | null;
  displayName: string | null;
}

export async function getWhatsAppWebhookConfig(): Promise<ActionResult<WhatsAppWebhookConfig>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const existing = await findOrgWhatsAppAccount(organizationId);

    return {
      ok: true,
      data: {
        whatsAppEnabled: env.WHATSAPP_ENABLED,
        connected: Boolean(existing?.encryptedCredentials),
        webhookUrl: existing ? webhookUrlFor(existing.id) : null,
        displayName: existing?.displayName ?? null,
      },
    };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

export interface WhatsAppHealthStatus {
  enabled: boolean;
  connected: boolean;
  healthy: boolean;
  detail?: string;
}

export async function getWhatsAppHealthStatus(): Promise<ActionResult<WhatsAppHealthStatus>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    if (!env.WHATSAPP_ENABLED) {
      return { ok: true, data: { enabled: false, connected: false, healthy: false, detail: "WHATSAPP_ENABLED is false." } };
    }

    const existing = await findOrgWhatsAppAccount(organizationId);
    if (!existing || !existing.encryptedCredentials) {
      return {
        ok: true,
        data: { enabled: true, connected: false, healthy: false, detail: "No WhatsApp account connected for this organization yet." },
      };
    }

    const adapter = channelAdapterRegistry.get("WHATSAPP") as WhatsAppAdapter | undefined;
    if (!adapter) {
      return { ok: true, data: { enabled: true, connected: true, healthy: false, detail: "WhatsApp adapter is not registered." } };
    }

    const health = await adapter.checkAccountHealth(existing);
    return { ok: true, data: { enabled: true, connected: true, ...health } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const connectWhatsAppAccountSchema = z.object({
  accessToken: z.string().min(1, "Access token is required."),
  phoneNumberId: z.string().min(1, "Phone number id is required."),
  businessAccountId: z.string().min(1, "Business account id is required."),
  appSecret: z.string().min(1, "App secret is required."),
  verifyToken: z.string().min(1, "Verify token is required."),
});

export interface ConnectWhatsAppAccountResult {
  webhookUrl: string;
  displayName: string;
  healthDetail?: string;
}

/**
 * "Connect a WhatsApp Business account" — an Administrator pastes their org's own Graph API
 * credentials. Runs `checkCredentialsHealth` (fetch this phone number's own info) BEFORE
 * ever encrypting/saving anything, so a bad credential is rejected with a clear message
 * rather than silently stored. On success, creates/updates this org's `ChannelAccount`
 * (keyed by `phoneNumberId`) and returns the per-account webhook URL to register in the
 * Meta App dashboard (registering the webhook itself remains a manual, external, Meta-side
 * step — see docs/channel-adapters.md — there is no Telegram-style "register automatically"
 * button here because Meta's webhook subscription isn't a plain API call this app can make
 * on the operator's behalf).
 */
export async function connectWhatsAppAccount(
  input: z.infer<typeof connectWhatsAppAccountSchema>,
): Promise<ActionResult<ConnectWhatsAppAccountResult>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    if (!env.WHATSAPP_ENABLED) {
      throw new NotConfiguredError("WhatsApp is not enabled for this deployment. Set WHATSAPP_ENABLED=true and restart the app first.");
    }

    const credentials = connectWhatsAppAccountSchema.parse(input);

    const adapter = channelAdapterRegistry.get("WHATSAPP") as WhatsAppAdapter | undefined;
    if (!adapter) {
      throw new NotConfiguredError("WhatsApp adapter is not registered (WHATSAPP_ENABLED is false).");
    }

    const health = await adapter.checkCredentialsHealth(credentials);
    if (!health.healthy) {
      throw new ValidationError(`Could not validate these WhatsApp credentials: ${health.detail ?? "unknown error"}`);
    }

    const encryptedCredentials = encryptWhatsAppCredentials(credentials);
    const displayName = health.detail ?? `WhatsApp (${credentials.phoneNumberId})`;

    const existing = await findOrgWhatsAppAccount(organizationId);

    let channelAccount: ChannelAccount;
    try {
      if (existing) {
        channelAccount = await channelAccountRepository.updateCredentials(organizationId, existing.id, {
          displayName,
          externalAccountId: credentials.phoneNumberId,
          encryptedCredentials,
          status: "ACTIVE",
        });
      } else {
        channelAccount = await channelAccountRepository.create(organizationId, {
          channelType: "WHATSAPP",
          displayName,
          externalAccountId: credentials.phoneNumberId,
          encryptedCredentials,
          status: "ACTIVE",
        });
      }
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictError(
          "This WhatsApp phone number is already connected to another organization. Each WhatsApp Business phone number can only be connected to one organization at a time.",
          { organizationId, phoneNumberId: credentials.phoneNumberId },
        );
      }
      throw error;
    }

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: existing ? "channel_account.credentials_rotated" : "channel_account.connected",
      entityType: "ChannelAccount",
      entityId: channelAccount.id,
      metadata: { channelType: "WHATSAPP", displayName },
    });

    return {
      ok: true,
      data: { webhookUrl: webhookUrlFor(channelAccount.id), displayName, healthDetail: health.detail },
    };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
