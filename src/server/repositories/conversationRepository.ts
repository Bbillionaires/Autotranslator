/**
 * Org-scoped repository for `Conversation`, per docs/implementation-plan.md §6.1.
 */
import type { ConversationStatus } from "@prisma/client";
import { prisma } from "../db";
import type { PrismaClientOrTx } from "../db";
import { NotFoundError } from "../errors";

export const conversationRepository = {
  async findByIdInOrg(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    return client.conversation.findFirst({ where: { id, organizationId } });
  },

  async findByIdInOrgOrThrow(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const conversation = await client.conversation.findFirst({ where: { id, organizationId } });
    if (!conversation) {
      throw new NotFoundError("Conversation not found.", { organizationId, id });
    }
    return conversation;
  },

  async findByContactAndChannelAccount(
    organizationId: string,
    contactId: string,
    channelAccountId: string,
    client: PrismaClientOrTx = prisma,
  ) {
    return client.conversation.findFirst({ where: { organizationId, contactId, channelAccountId } });
  },

  /**
   * Resolves the canonical conversation for `(contactId, channelAccountId)` — creating it
   * on first contact — per the inbound lifecycle (§3.5 step 5) and the schema's
   * `@@unique([contactId, channelAccountId])` constraint. Uses `upsert` (not
   * find-then-create) so concurrent inbound webhooks for a brand-new contact can't race
   * into a unique-constraint violation on the conversation itself.
   */
  async upsertForContactAndChannel(
    organizationId: string,
    contactId: string,
    channelAccountId: string,
    client: PrismaClientOrTx = prisma,
  ) {
    return client.conversation.upsert({
      where: { contactId_channelAccountId: { contactId, channelAccountId } },
      create: { organizationId, contactId, channelAccountId },
      update: {},
    });
  },

  async touchLastMessageAt(
    organizationId: string,
    id: string,
    lastMessageAt: Date,
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.conversation.updateMany({
      where: { id, organizationId },
      data: { lastMessageAt },
    });
    if (result.count === 0) {
      throw new NotFoundError("Conversation not found.", { organizationId, id });
    }
    return conversationRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  async setStatus(organizationId: string, id: string, status: ConversationStatus, client: PrismaClientOrTx = prisma) {
    const result = await client.conversation.updateMany({ where: { id, organizationId }, data: { status } });
    if (result.count === 0) {
      throw new NotFoundError("Conversation not found.", { organizationId, id });
    }
    return conversationRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  async setLanguageOverride(
    organizationId: string,
    id: string,
    preferredLanguageOverride: string | null,
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.conversation.updateMany({
      where: { id, organizationId },
      data: { preferredLanguageOverride },
    });
    if (result.count === 0) {
      throw new NotFoundError("Conversation not found.", { organizationId, id });
    }
    return conversationRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  async assign(
    organizationId: string,
    id: string,
    input: { assignedUserId?: string | null; assignedTeamId?: string | null },
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.conversation.updateMany({
      where: { id, organizationId },
      data: input,
    });
    if (result.count === 0) {
      throw new NotFoundError("Conversation not found.", { organizationId, id });
    }
    return conversationRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  async listByOrg(
    organizationId: string,
    options: { status?: ConversationStatus } = {},
    client: PrismaClientOrTx = prisma,
  ) {
    return client.conversation.findMany({
      where: { organizationId, ...(options.status ? { status: options.status } : {}) },
      orderBy: { lastMessageAt: "desc" },
    });
  },
};
