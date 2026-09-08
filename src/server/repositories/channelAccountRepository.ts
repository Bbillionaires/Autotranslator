/**
 * Org-scoped repository for `ChannelAccount`, per docs/implementation-plan.md §6.1. See
 * contactRepository.ts for the `client` param rationale (transaction threading).
 */
import type { ChannelAccountStatus, ChannelType, Prisma } from "@prisma/client";
import type { EncryptedCredentialsBlob } from "../crypto/credentialEncryption";
import { prisma } from "../db";
import type { PrismaClientOrTx } from "../db";
import { NotFoundError } from "../errors";

export interface CreateChannelAccountInput {
  channelType: ChannelType;
  displayName: string;
  externalAccountId?: string | null;
  credentialRef?: string | null;
  encryptedCredentials?: EncryptedCredentialsBlob | null;
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
   * Cross-org lookup by bare id — a legitimate exception to "every repository function
   * takes the caller's organizationId", needed whenever the caller must resolve WHICH
   * organization a request belongs to from an id alone, before any `organizationId` is
   * known. Used by:
   *   - `src/server/gateways/androidAuth.ts`, to resolve a device's `ChannelAccount` from
   *     the deviceId embedded in its signed token — every other Android gateway operation
   *     is immediately re-scoped to `channelAccount.organizationId` once this resolves it.
   *   - The per-organization Telegram/WhatsApp webhook routes
   *     (`src/app/api/channels/telegram/webhook/[channelAccountId]/route.ts`,
   *     `.../whatsapp/webhook/[channelAccountId]/route.ts`), to resolve the `ChannelAccount`
   *     named by the webhook URL's path segment — the whole point of the per-account URL
   *     design is that the URL itself identifies the account, so its org is derived from
   *     THIS lookup, then that account's own decrypted webhook secret/signature key
   *     verifies the request actually belongs to it (never trusting the URL alone).
   */
  async findById(id: string, client: PrismaClientOrTx = prisma) {
    return client.channelAccount.findUnique({ where: { id } });
  },

  /**
   * Cross-org lookup by channel type + `externalAccountId`. Used ONLY by the WhatsApp
   * webhook route to resolve which organization's `ChannelAccount` an inbound webhook
   * `value` block belongs to, via `value.metadata.phone_number_id` (§3.5 step 2) — kept for
   * that one call site; the per-account webhook route itself resolves by `ChannelAccount.id`
   * (`findById` above), not by this lookup. Global uniqueness of
   * `(channelType, externalAccountId)` is now enforced at the DB level (see
   * `prisma/schema.prisma`'s `ChannelAccount` doc comment), so this can never return more
   * than one row across organizations.
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
        encryptedCredentials: (input.encryptedCredentials as unknown as Prisma.InputJsonValue | undefined) ?? undefined,
        status: input.status,
      },
    });
  },

  /**
   * Updates an existing `ChannelAccount`'s encrypted credentials (and, typically alongside
   * them, its `externalAccountId`/`displayName`/`status`) — the "connect/reconnect a
   * Telegram bot or WhatsApp account" write path (`src/server/actions/telegram.ts`,
   * `.../whatsapp.ts`). Distinct from `create` because re-registering an org's channel
   * (e.g. rotating the bot token, or re-entering WhatsApp credentials after they expired)
   * updates the SAME `ChannelAccount` row rather than creating a second one for that org.
   */
  async updateCredentials(
    organizationId: string,
    id: string,
    input: {
      displayName?: string;
      externalAccountId?: string | null;
      encryptedCredentials: EncryptedCredentialsBlob;
      status?: ChannelAccountStatus;
    },
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.channelAccount.updateMany({
      where: { id, organizationId },
      data: {
        displayName: input.displayName,
        externalAccountId: input.externalAccountId,
        encryptedCredentials: input.encryptedCredentials as unknown as Prisma.InputJsonValue,
        status: input.status,
      },
    });
    if (result.count === 0) {
      throw new NotFoundError("Channel account not found.", { organizationId, id });
    }
    return channelAccountRepository.findByIdInOrgOrThrow(organizationId, id, client);
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
