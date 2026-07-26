/**
 * Repository for `MessageEvent`, per docs/implementation-plan.md §6.1/§4.
 *
 * `MessageEvent` has no `organizationId` column of its own — it hangs off `Message`, which
 * does — so every lookup joins through `message: { organizationId }` to preserve org
 * isolation. `eventType` is a free-form string per the schema comment (`"received" |
 * "sent" | "delivered" | "read" | "failed" | "retry_scheduled" | "duplicate_webhook_ignored"`),
 * not a Prisma enum, so it's typed here as a union of the values this codebase actually
 * writes.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import type { PrismaClientOrTx } from "../db";

export type MessageEventType =
  | "received"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "retry_scheduled"
  | "dead_letter"
  | "duplicate_webhook_ignored"
  | "internal_note_added"
  | "translation_edited"
  // Phase 8 (Android SMS gateway): the adapter accepted the message for device pickup
  // (`AndroidSmsAdapter.sendMessage` returning `status: "QUEUED"`) — distinct from "sent"
  // since the channel hasn't actually transmitted it yet, only queued it.
  | "queued_for_pickup"
  // Phase 8: the device confirmed it actually sent the SMS
  // (`POST /api/gateways/messages/:id/acknowledge`).
  | "device_acknowledged";

export interface CreateMessageEventInput {
  messageId: string;
  eventType: MessageEventType;
  externalEventId?: string | null;
  payload?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
}

export const messageEventRepository = {
  async create(input: CreateMessageEventInput, client: PrismaClientOrTx = prisma) {
    return client.messageEvent.create({
      data: {
        messageId: input.messageId,
        eventType: input.eventType,
        externalEventId: input.externalEventId ?? undefined,
        payload: input.payload ?? undefined,
      },
    });
  },

  async listByMessage(organizationId: string, messageId: string, client: PrismaClientOrTx = prisma) {
    return client.messageEvent.findMany({
      where: { messageId, message: { organizationId } },
      orderBy: { createdAt: "asc" },
    });
  },

  async findLatestByType(
    organizationId: string,
    messageId: string,
    eventType: MessageEventType,
    client: PrismaClientOrTx = prisma,
  ) {
    return client.messageEvent.findFirst({
      where: { messageId, eventType, message: { organizationId } },
      orderBy: { createdAt: "desc" },
    });
  },

  async countByType(
    organizationId: string,
    messageId: string,
    eventType: MessageEventType,
    client: PrismaClientOrTx = prisma,
  ) {
    return client.messageEvent.count({ where: { messageId, eventType, message: { organizationId } } });
  },
};
