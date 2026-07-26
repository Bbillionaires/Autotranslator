/**
 * Org-scoped repository for `ChannelAccount`, per docs/implementation-plan.md §6.1. See
 * contactRepository.ts for the `client` param rationale (transaction threading).
 */
import type { ChannelAccountStatus, ChannelType } from "@prisma/client";
import { prisma } from "../db";
import type { PrismaClientOrTx } from "../db";
import { NotFoundError } from "../errors";

export interface CreateChannelAccountInput {
  channelType: ChannelType;
  displayName: string;
  externalAccountId?: string | null;
  credentialRef?: string | null;
  status?: ChannelAccountStatus;
}

export const channelAccountRepository = {
  async findByIdInOrg(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    return client.channelAccount.findFirst({ where: { id, organizationId } });
  },

  async findByIdInOrgOrThrow(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const channelAccount = await client.channelAccount.findFirst({ where: { id, organizationId } });
    if (!channelAccount) {
      throw new NotFoundError("Channel account not found.", { organizationId, id });
    }
    return channelAccount;
  },

  async listByOrg(organizationId: string, client: PrismaClientOrTx = prisma) {
    return client.channelAccount.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
  },

  async listByChannelType(organizationId: string, channelType: ChannelType, client: PrismaClientOrTx = prisma) {
    return client.channelAccount.findMany({ where: { organizationId, channelType } });
  },

  /**
   * Cross-org existence check — used ONLY by `registerTelegramWebhook`
   * (`src/server/actions/telegram.ts`) to hard-block a second organization from ever
   * activating a Telegram `ChannelAccount` while this deployment shares one global
   * `TELEGRAM_BOT_TOKEN` (see C1 in docs/review-report.md, fixed here: previously nothing
   * prevented a second org from creating its own ACTIVE Telegram `ChannelAccount`, which
   * caused every inbound webhook to silently resolve to whichever org's account was
   * created first — real cross-tenant data leakage). Returns the first ACTIVE
   * `ChannelAccount` of `channelType` belonging to any organization OTHER than
   * `organizationId`, or `null` if none exists (the common, single-org case).
   */
  async findFirstActiveByChannelTypeInOtherOrg(
    channelType: ChannelType,
    organizationId: string,
    client: PrismaClientOrTx = prisma,
  ) {
    return client.channelAccount.findFirst({
      where: { channelType, status: "ACTIVE", organizationId: { not: organizationId } },
      orderBy: { createdAt: "asc" },
    });
  },

  /**
   * Cross-org lookup by bare id — a legitimate exception to "every repository function
   * takes the caller's organizationId" (see `findFirstActiveByChannelTypeInOtherOrg` above
   * for a related precedent). Used ONLY by `src/server/gateways/androidAuth.ts` to
   * resolve a device's `ChannelAccount` from the deviceId embedded in its signed token,
   * *before* any `organizationId` is known — unlike every other Android gateway operation,
   * which is immediately re-scoped to `channelAccount.organizationId` once this lookup
   * resolves it. Each Android device is genuinely per-org/per-device (its own issued
   * token), so — unlike Telegram's single-global-bot-token shortcut — this is not a
   * multi-tenancy shortcut, just the unavoidable bootstrapping step of "whose device is
   * this token for?".
   */
  async findById(id: string, client: PrismaClientOrTx = prisma) {
    return client.channelAccount.findUnique({ where: { id } });
  },

  /**
   * Cross-org lookup by channel type + `externalAccountId` — the WhatsApp analogue of
   * `listAllActiveByChannelType` below. Used ONLY by the WhatsApp webhook route
   * (`src/app/api/channels/whatsapp/webhook/route.ts`) to resolve which organization's
   * `ChannelAccount` an inbound webhook `value` block belongs to, via
   * `value.metadata.phone_number_id` (§3.5 step 2: "for WhatsApp, the phone_number_id in the
   * payload") — deliberately per-`phone_number_id`, unlike Telegram's single-global-bot-token
   * shortcut, since a deployment could in principle have multiple WhatsApp Business phone
   * numbers each mapped to its own `ChannelAccount.externalAccountId`. Still a documented
   * MVP simplification in the sense that it doesn't disambiguate two different
   * *organizations* both somehow registering the same real phone number (shouldn't happen —
   * a phone number belongs to exactly one WhatsApp Business Account — but nothing in this
   * schema enforces global uniqueness of `externalAccountId` across orgs).
   */
  async findActiveByChannelTypeAndExternalAccountId(
    channelType: ChannelType,
    externalAccountId: string,
    client: PrismaClientOrTx = prisma,
  ) {
    return client.channelAccount.findFirst({
      where: { channelType, externalAccountId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });
  },

  /**
   * All ACTIVE, non-revoked `ChannelAccount`s of a given channel type across every
   * organization. Cross-org for the same reason as `findById` above — used by
   * `AndroidSmsAdapter.healthCheck()` (the parameterless, interface-required method) to
   * report an aggregate "is at least one gateway device alive" summary, since the
   * `MessagingChannelAdapter` interface has no per-org/per-device parameter to narrow with.
   * Per-device health (the actually useful signal) is `AndroidSmsAdapter.getDeviceHealth`,
   * which IS org-scoped.
   */
  async listAllActiveByChannelType(channelType: ChannelType, client: PrismaClientOrTx = prisma) {
    return client.channelAccount.findMany({
      where: { channelType, status: "ACTIVE", revokedAt: null },
    });
  },

  async create(organizationId: string, input: CreateChannelAccountInput, client: PrismaClientOrTx = prisma) {
    return client.channelAccount.create({
      data: {
        organizationId,
        channelType: input.channelType,
        displayName: input.displayName,
        externalAccountId: input.externalAccountId ?? undefined,
        credentialRef: input.credentialRef ?? undefined,
        status: input.status,
      },
    });
  },

  async updateStatus(
    organizationId: string,
    id: string,
    status: ChannelAccountStatus,
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.channelAccount.updateMany({ where: { id, organizationId }, data: { status } });
    if (result.count === 0) {
      throw new NotFoundError("Channel account not found.", { organizationId, id });
    }
    return channelAccountRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  /**
   * Persists the sha256 hash of a newly-issued Android gateway device token (never the raw
   * token — see src/server/gateways/androidAuth.ts). Called once, at registration.
   */
  async setDeviceTokenHash(organizationId: string, id: string, deviceTokenHash: string, client: PrismaClientOrTx = prisma) {
    const result = await client.channelAccount.updateMany({ where: { id, organizationId }, data: { deviceTokenHash } });
    if (result.count === 0) {
      throw new NotFoundError("Channel account not found.", { organizationId, id });
    }
    return channelAccountRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  /** Bumps `lastHeartbeatAt` to now and flips a non-revoked device to ACTIVE. Called by `POST /api/gateways/heartbeat`. */
  async touchHeartbeat(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const result = await client.channelAccount.updateMany({
      where: { id, organizationId, revokedAt: null },
      data: { lastHeartbeatAt: new Date(), status: "ACTIVE" },
    });
    if (result.count === 0) {
      throw new NotFoundError("Channel account not found.", { organizationId, id });
    }
    return channelAccountRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  /**
   * Revokes an Android gateway device: sets `revokedAt`, which `androidAuth.authenticateDevice`
   * checks on every subsequent request — the token stops working immediately, with no need
   * to rotate `ANDROID_GATEWAY_SIGNING_SECRET` (which would revoke every other device too).
   * Idempotent: revoking an already-revoked device is a no-op, not an error.
   */
  async revokeDevice(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const existing = await channelAccountRepository.findByIdInOrgOrThrow(organizationId, id, client);
    if (existing.revokedAt) {
      return existing;
    }
    await client.channelAccount.updateMany({
      where: { id, organizationId },
      data: { revokedAt: new Date(), status: "DISABLED" },
    });
    return channelAccountRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },
};
