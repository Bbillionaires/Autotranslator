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
};
