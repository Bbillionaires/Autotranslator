/**
 * Org-scoped repository for `Conversation`, per docs/implementation-plan.md §6.1.
 */
import type { ChannelType, ConversationStatus, Prisma } from "@prisma/client";
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

  async setHighRisk(organizationId: string, id: string, highRisk: boolean, client: PrismaClientOrTx = prisma) {
    const result = await client.conversation.updateMany({ where: { id, organizationId }, data: { highRisk } });
    if (result.count === 0) {
      throw new NotFoundError("Conversation not found.", { organizationId, id });
    }
    return conversationRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  /**
   * Full detail load for the conversation view (Phase 7): contact (+identities), channel
   * account, assigned user/team, and organization (needed for the §3.4 target-language
   * resolution chain) in one round trip.
   */
  async findDetailByIdInOrgOrThrow(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const conversation = await client.conversation.findFirst({
      where: { id, organizationId },
      include: {
        contact: { include: { identities: { include: { channelAccount: true } } } },
        channelAccount: true,
        assignedUser: true,
        assignedTeam: true,
        organization: true,
      },
    });
    if (!conversation) {
      throw new NotFoundError("Conversation not found.", { organizationId, id });
    }
    return conversation;
  },

  /**
   * Inbox list query, per docs/implementation-plan.md Phase 7 ("Conversation list: channel
   * icon, contact name, preferred language, last-message preview, assignment, unread count,
   * delivery status of last message, search box, filters by channel/language/assigned-
   * teammate/status/unread"). No such method existed before Phase 7 — `listByOrg` only
   * supported a bare status filter.
   *
   * "Unread" has no dedicated schema column (no per-user read-tracking exists in the Phase
   * 3-6 schema and adding one is out of this phase's additive-migration budget — flagged as
   * a documented heuristic, not a gap): a conversation counts as having N unread messages
   * when N inbound messages have arrived since the most recent externally-sent (non-internal-
   * note) outbound message — i.e. messages the contact sent that haven't been responded to
   * yet. If no outbound message exists at all, every inbound message counts as unread.
   */
  async listForInbox(
    organizationId: string,
    filters: {
      channel?: ChannelType;
      language?: string;
      assignedUserId?: string;
      assignedTeamId?: string;
      unassigned?: boolean;
      status?: ConversationStatus;
      search?: string;
      unreadOnly?: boolean;
    } = {},
    client: PrismaClientOrTx = prisma,
  ) {
    const where: Prisma.ConversationWhereInput = {
      organizationId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.channel ? { channelAccount: { channelType: filters.channel } } : {}),
      ...(filters.unassigned ? { assignedUserId: null, assignedTeamId: null } : {}),
      ...(filters.assignedUserId ? { assignedUserId: filters.assignedUserId } : {}),
      ...(filters.assignedTeamId ? { assignedTeamId: filters.assignedTeamId } : {}),
      ...(filters.language
        ? {
            OR: [
              { preferredLanguageOverride: filters.language },
              { preferredLanguageOverride: null, contact: { preferredLanguage: filters.language } },
              {
                preferredLanguageOverride: null,
                contact: { preferredLanguage: null, detectedLanguage: filters.language },
              },
            ],
          }
        : {}),
      ...(filters.search
        ? {
            OR: [
              { contact: { displayName: { contains: filters.search, mode: "insensitive" } } },
              { contact: { phoneNumber: { contains: filters.search, mode: "insensitive" } } },
              {
                messages: {
                  some: {
                    isInternalNote: false,
                    OR: [
                      { originalText: { contains: filters.search, mode: "insensitive" } },
                      { translatedText: { contains: filters.search, mode: "insensitive" } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };

    const conversations = await client.conversation.findMany({
      where,
      include: {
        contact: true,
        channelAccount: true,
        assignedUser: true,
        assignedTeam: true,
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 200,
    });

    const withUnread = await Promise.all(
      conversations.map(async (conversation) => {
        const lastOutbound = await client.message.findFirst({
          where: { organizationId, conversationId: conversation.id, direction: "OUTBOUND", isInternalNote: false },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        const unreadCount = await client.message.count({
          where: {
            organizationId,
            conversationId: conversation.id,
            direction: "INBOUND",
            ...(lastOutbound ? { createdAt: { gt: lastOutbound.createdAt } } : {}),
          },
        });
        return { ...conversation, lastMessage: conversation.messages[0] ?? null, unreadCount };
      }),
    );

    return filters.unreadOnly ? withUnread.filter((c) => c.unreadCount > 0) : withUnread;
  },
};
