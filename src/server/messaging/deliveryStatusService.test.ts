/**
 * Integration tests for `deliveryStatusService.applyDeliveryStatusUpdate`, run against a
 * REAL Postgres test database (same pattern as `inboundService.test.ts`/`outboundService.test.ts`
 * — see `./__tests__/testDb.ts`). Exercises the Phase 9 task brief's required behaviors: a
 * `delivered` then `read` status update transitions the `Message` status forward correctly
 * and idempotently (a duplicate status callback doesn't double-record a `MessageEvent`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureTestDatabaseEnv } from "./__tests__/testDb";

configureTestDatabaseEnv();

const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { contactRepository } = await import("../repositories/contactRepository");
const { contactChannelIdentityRepository } = await import("../repositories/contactChannelIdentityRepository");
const { conversationRepository } = await import("../repositories/conversationRepository");
const { messageRepository } = await import("../repositories/messageRepository");
const { messageEventRepository } = await import("../repositories/messageEventRepository");
const { applyDeliveryStatusUpdate } = await import("./deliveryStatusService");

let organizationId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

async function setUpSentOutboundMessage(externalMessageId: string) {
  const organization = await organizationRepository.create({ name: `Delivery Status Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;

  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "WHATSAPP",
    displayName: "Test WhatsApp number",
    externalAccountId: "1234567890",
    status: "ACTIVE",
  });
  const contact = await contactRepository.create(organizationId, { displayName: "Test Contact", phoneNumber: "+5215512345678" });
  await contactChannelIdentityRepository.create(organizationId, {
    contactId: contact.id,
    channelAccountId: channelAccount.id,
    externalContactId: "5215512345678",
    phoneNumber: "+5215512345678",
  });
  const conversation = await conversationRepository.upsertForContactAndChannel(organizationId, contact.id, channelAccount.id);

  const message = await messageRepository.create({
    organizationId,
    conversationId: conversation.id,
    senderType: "USER",
    direction: "OUTBOUND",
    originalText: "Hello",
    translatedText: "Hola",
    channelType: "WHATSAPP",
    externalMessageId,
    status: "SENT",
    idempotencyKey: `outbound-${externalMessageId}`,
  });

  return { organization, channelAccount, contact, conversation, message };
}

describe("applyDeliveryStatusUpdate", () => {
  it("transitions SENT -> DELIVERED -> READ across two callbacks, recording distinct MessageEvents", async () => {
    const { message } = await setUpSentOutboundMessage("wamid.DELIVREAD1");

    const delivered = await applyDeliveryStatusUpdate(
      organizationId,
      { externalMessageId: "wamid.DELIVREAD1", status: "DELIVERED", occurredAt: new Date() },
      "wamid.DELIVREAD1:delivered:1000",
    );
    expect(delivered.recorded).toBe(true);
    expect(delivered.message?.status).toBe("DELIVERED");

    const read = await applyDeliveryStatusUpdate(
      organizationId,
      { externalMessageId: "wamid.DELIVREAD1", status: "READ", occurredAt: new Date() },
      "wamid.DELIVREAD1:read:1001",
    );
    expect(read.recorded).toBe(true);
    expect(read.message?.status).toBe("READ");

    const final = await messageRepository.findByIdInOrgOrThrow(organizationId, message.id);
    expect(final.status).toBe("READ");

    const events = await messageEventRepository.listByMessage(organizationId, message.id);
    expect(events.filter((e) => e.eventType === "delivered")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "read")).toHaveLength(1);
  });

  it("a duplicate status callback (same externalEventId) is ignored — exactly one MessageEvent, status unchanged by the repeat", async () => {
    const { message } = await setUpSentOutboundMessage("wamid.DUPCALLBACK1");

    const first = await applyDeliveryStatusUpdate(
      organizationId,
      { externalMessageId: "wamid.DUPCALLBACK1", status: "DELIVERED", occurredAt: new Date() },
      "wamid.DUPCALLBACK1:delivered:2000",
    );
    expect(first.recorded).toBe(true);

    const second = await applyDeliveryStatusUpdate(
      organizationId,
      { externalMessageId: "wamid.DUPCALLBACK1", status: "DELIVERED", occurredAt: new Date() },
      "wamid.DUPCALLBACK1:delivered:2000",
    );
    expect(second.recorded).toBe(false);
    expect(second.ignoredReason).toBe("duplicate");

    const events = await messageEventRepository.listByMessage(organizationId, message.id);
    expect(events.filter((e) => e.eventType === "delivered")).toHaveLength(1);

    const final = await messageRepository.findByIdInOrgOrThrow(organizationId, message.id);
    expect(final.status).toBe("DELIVERED");
  });

  it("a FAILED callback with a failureReason transitions SENT -> FAILED and stores the reason", async () => {
    await setUpSentOutboundMessage("wamid.FAILCB1");

    const result = await applyDeliveryStatusUpdate(
      organizationId,
      { externalMessageId: "wamid.FAILCB1", status: "FAILED", occurredAt: new Date(), failureReason: "Recipient number is not a WhatsApp user" },
      "wamid.FAILCB1:failed:3000",
    );
    expect(result.recorded).toBe(true);
    expect(result.message?.status).toBe("FAILED");
    expect(result.message?.failureReason).toBe("Recipient number is not a WhatsApp user");
  });

  it("returns ignoredReason 'message_not_found' for an externalMessageId with no matching Message, without throwing", async () => {
    const organization = await organizationRepository.create({ name: `Delivery Status Unknown Msg Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;

    const result = await applyDeliveryStatusUpdate(
      organizationId,
      { externalMessageId: "wamid.DOES_NOT_EXIST", status: "DELIVERED", occurredAt: new Date() },
      "wamid.DOES_NOT_EXIST:delivered:4000",
    );
    expect(result.recorded).toBe(false);
    expect(result.ignoredReason).toBe("message_not_found");
  });

  it("an out-of-order callback (e.g. DELIVERED arriving after READ) records the event but does not regress Message.status", async () => {
    const { message } = await setUpSentOutboundMessage("wamid.OUTOFORDER1");

    await applyDeliveryStatusUpdate(
      organizationId,
      { externalMessageId: "wamid.OUTOFORDER1", status: "DELIVERED", occurredAt: new Date() },
      "wamid.OUTOFORDER1:delivered:5000",
    );
    await applyDeliveryStatusUpdate(
      organizationId,
      { externalMessageId: "wamid.OUTOFORDER1", status: "READ", occurredAt: new Date() },
      "wamid.OUTOFORDER1:read:5001",
    );

    // A late/duplicated-in-effect "delivered" arriving AFTER "read" is not a valid forward
    // transition (READ -> DELIVERED) — the event is still recorded for audit, but the
    // Message's status must not regress.
    const late = await applyDeliveryStatusUpdate(
      organizationId,
      { externalMessageId: "wamid.OUTOFORDER1", status: "DELIVERED", occurredAt: new Date() },
      "wamid.OUTOFORDER1:delivered:5002",
    );
    expect(late.recorded).toBe(true);
    expect(late.ignoredReason).toBe("invalid_transition");

    const final = await messageRepository.findByIdInOrgOrThrow(organizationId, message.id);
    expect(final.status).toBe("READ");
  });
});
