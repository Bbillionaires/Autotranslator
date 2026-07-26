/**
 * Org-scoped repository for `ContactChannelIdentity`, per docs/implementation-plan.md
 * §6.1. This model has no `organizationId` column of its own (it hangs off `Contact`/
 * `ChannelAccount`, both of which do), so every lookup joins through `channelAccount:
 * { organizationId }` to keep the same "never trust a bare id across tenants" discipline
 * as every other repository in this directory.
 */
import { prisma } from "../db";
import type { PrismaClientOrTx } from "../db";
import { NotFoundError } from "../errors";

export interface CreateContactChannelIdentityInput {
  contactId: string;
  channelAccountId: string;
  externalContactId: string;
  externalUsername?: string | null;
  phoneNumber?: string | null;
  metadata?: unknown;
}

export const contactChannelIdentityRepository = {
  /**
   * Resolves the identity for a given channel account + external contact id — the lookup
   * the inbound lifecycle (§3.5 step 5) uses to find an existing `Contact` for a webhook
   * sender before deciding whether to create a new one.
   */
  async findByChannelAndExternalId(
    organizationId: string,
    channelAccountId: string,
    externalContactId: string,
    client: PrismaClientOrTx = prisma,
  ) {
    return client.contactChannelIdentity.findFirst({
      where: { channelAccountId, externalContactId, channelAccount: { organizationId } },
    });
  },

  /**
   * The inverse lookup of `findByChannelAndExternalId` — given a `Contact` we already know
   * and the `ChannelAccount` we're about to send through, resolves the external contact id
   * (e.g. a Telegram chat id, a phone number) the outbound lifecycle (§3.6) needs to pass
   * to `adapter.sendMessage()`.
   */
  async findByContactAndChannelAccount(
    organizationId: string,
    contactId: string,
    channelAccountId: string,
    client: PrismaClientOrTx = prisma,
  ) {
    return client.contactChannelIdentity.findFirst({
      where: { contactId, channelAccountId, channelAccount: { organizationId } },
    });
  },

  async findByIdInOrgOrThrow(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const identity = await client.contactChannelIdentity.findFirst({
      where: { id, channelAccount: { organizationId } },
    });
    if (!identity) {
      throw new NotFoundError("Contact channel identity not found.", { organizationId, id });
    }
    return identity;
  },

  async listByContact(organizationId: string, contactId: string, client: PrismaClientOrTx = prisma) {
    return client.contactChannelIdentity.findMany({
      where: { contactId, channelAccount: { organizationId } },
    });
  },

  async create(
    organizationId: string,
    input: CreateContactChannelIdentityInput,
    client: PrismaClientOrTx = prisma,
  ) {
    // Defense-in-depth: verify the channel account actually belongs to this org before
    // creating the identity, even though callers are expected to have already resolved it
    // from an org-scoped channelAccountRepository lookup.
    const channelAccount = await client.channelAccount.findFirst({
      where: { id: input.channelAccountId, organizationId },
      select: { id: true },
    });
    if (!channelAccount) {
      throw new NotFoundError("Channel account not found.", { organizationId, channelAccountId: input.channelAccountId });
    }

    return client.contactChannelIdentity.create({
      data: {
        contactId: input.contactId,
        channelAccountId: input.channelAccountId,
        externalContactId: input.externalContactId,
        externalUsername: input.externalUsername ?? undefined,
        phoneNumber: input.phoneNumber ?? undefined,
        metadata: input.metadata === undefined ? undefined : (input.metadata as never),
      },
    });
  },
};
