/**
 * Org-scoped repository for `Message`, per docs/implementation-plan.md §6.1 and §4's
 * idempotency design: `Message.idempotencyKey` is unique per organization
 * (`@@unique([organizationId, idempotencyKey])`) and is the single mechanism both the
 * inbound (§3.5) and outbound (§3.6) lifecycles rely on to avoid double-processing a
 * retried webhook or a retried compose call. `messagingService`/`inboundService` /
 * `outboundService` are expected to *attempt* `create()` and catch the resulting P2002
 * (see `isUniqueConstraintViolation` in `../db`) rather than pre-checking with
 * `findByIdempotencyKey` first — that's what makes the dedupe race-safe under concurrent
 * webhook retries.
 */
import type { ChannelType, MessageDirection, MessageStatus, Prisma, SenderType } from "@prisma/client";
import { prisma } from "../db";
import type { PrismaClientOrTx } from "../db";
import { NotFoundError } from "../errors";

export interface CreateMessageInput {
  organizationId: string;
  conversationId: string;
  senderType: SenderType;
  direction: MessageDirection;
  originalText: string;
  translatedText?: string | null;
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
  translationProvider?: string | null;
  translationConfidence?: number | null;
  translationEdited?: boolean;
  channelType: ChannelType;
  externalMessageId?: string | null;
  externalReplyToId?: string | null;
  status: MessageStatus;
  failureReason?: string | null;
  idempotencyKey: string;
  isInternalNote?: boolean;
}

export const messageRepository = {
  async findByIdInOrg(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    return client.message.findFirst({ where: { id, organizationId } });
  },

  async findByIdInOrgOrThrow(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const message = await client.message.findFirst({ where: { id, organizationId } });
    if (!message) {
      throw new NotFoundError("Message not found.", { organizationId, id });
    }
    return message;
  },

  /**
   * Looked up after a `create()` throws a unique-constraint violation on
   * `(organizationId, idempotencyKey)` — the record that already exists is the "current
   * state" a duplicate webhook or double-submit short-circuits to.
   */
  async findByIdempotencyKey(organizationId: string, idempotencyKey: string, client: PrismaClientOrTx = prisma) {
    return client.message.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
    });
  },

  async create(input: CreateMessageInput, client: PrismaClientOrTx = prisma) {
    return client.message.create({ data: input });
  },

  async updateStatus(
    organizationId: string,
    id: string,
    status: MessageStatus,
    extra: { failureReason?: string | null; externalMessageId?: string | null } = {},
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.message.updateMany({
      where: { id, organizationId },
      data: { status, ...extra },
    });
    if (result.count === 0) {
      throw new NotFoundError("Message not found.", { organizationId, id });
    }
    return messageRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  async markTranslationEdited(
    organizationId: string,
    id: string,
    translatedText: string,
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.message.updateMany({
      where: { id, organizationId },
      data: { translatedText, translationEdited: true },
    });
    if (result.count === 0) {
      throw new NotFoundError("Message not found.", { organizationId, id });
    }
    return messageRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  async listByConversation(
    organizationId: string,
    conversationId: string,
    options: { cursor?: string; take?: number } = {},
    client: PrismaClientOrTx = prisma,
  ) {
    return client.message.findMany({
      where: { organizationId, conversationId },
      orderBy: { createdAt: "asc" },
      take: options.take ?? 50,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
  },

  async listFailedAwaitingRetry(
    organizationId: string,
    client: PrismaClientOrTx = prisma,
  ): Promise<Array<Prisma.MessageGetPayload<{ include: { events: true } }>>> {
    return client.message.findMany({
      where: { organizationId, status: "FAILED", isInternalNote: false },
      include: { events: { where: { eventType: "retry_scheduled" }, orderBy: { createdAt: "desc" } } },
    });
  },
};
