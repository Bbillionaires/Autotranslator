/**
 * Integration tests for `messageLifecycle.ts` (the service layer behind
 * `GET /messages/pending`, `POST /messages/:id/acknowledge`, `POST /messages/:id/fail`), run
 * against a REAL Postgres test database. Exercises the Phase 8 task brief's required
 * behaviors: org/device isolation on `pending`, idempotent acknowledge (exactly one
 * `MessageEvent` even on a double call), and transient-vs-permanent `fail` classification.
 * Also proves the "offline queueing" story (deliverable #5): a message queued while a
 * device has no recent heartbeat simply accumulates and is returned once polled.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.ANDROID_GATEWAY_ENABLED = "true";
process.env.ANDROID_GATEWAY_SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { contactRepository } = await import("../repositories/contactRepository");
const { contactChannelIdentityRepository } = await import("../repositories/contactChannelIdentityRepository");
const { conversationRepository } = await import("../repositories/conversationRepository");
const { messageEventRepository } = await import("../repositories/messageEventRepository");
const { sendMessage } = await import("../messaging/outboundService");
const { AndroidSmsAdapter } = await import("../channels/androidSms/adapter");
const { listPendingMessagesForDevice, acknowledgeMessage, failMessage } = await import("./messageLifecycle");

const adapter = new AndroidSmsAdapter();
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

async function setUpDeviceConversation(phoneSuffix: string) {
  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "ANDROID_SMS",
    displayName: `Device ${phoneSuffix}`,
    externalAccountId: `+1555device${phoneSuffix}`,
    status: "ACTIVE",
  });
  const contact = await contactRepository.create(organizationId, {
    displayName: `Contact ${phoneSuffix}`,
    phoneNumber: `+1555contact${phoneSuffix}`,
  });
  await contactChannelIdentityRepository.create(organizationId, {
    contactId: contact.id,
    channelAccountId: channelAccount.id,
    externalContactId: `+1555contact${phoneSuffix}`,
    phoneNumber: `+1555contact${phoneSuffix}`,
  });
  const conversation = await conversationRepository.upsertForContactAndChannel(organizationId, contact.id, channelAccount.id);
  return { channelAccount, contact, conversation };
}

async function queueOutboundMessage(conversationId: string, text = "Hello from staff") {
  const result = await sendMessage({ organizationId, conversationId, text }, { adapter });
  return result.message;
}

describe("listPendingMessagesForDevice — org/device isolation", () => {
  it("returns only the requesting device's own QUEUED messages, never another device's in the same org", async () => {
    const organization = await organizationRepository.create({ name: `Pending Isolation Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;

    const deviceA = await setUpDeviceConversation("A");
    const deviceB = await setUpDeviceConversation("B");

    const messageA = await queueOutboundMessage(deviceA.conversation.id, "For device A");
    const messageB = await queueOutboundMessage(deviceB.conversation.id, "For device B");

    const pendingForA = await listPendingMessagesForDevice(deviceA.channelAccount);
    expect(pendingForA.map((m) => m.id)).toEqual([messageA.id]);
    expect(pendingForA.map((m) => m.id)).not.toContain(messageB.id);

    const pendingForB = await listPendingMessagesForDevice(deviceB.channelAccount);
    expect(pendingForB.map((m) => m.id)).toEqual([messageB.id]);
  });

  it("never leaks another organization's pending messages", async () => {
    const orgOne = await organizationRepository.create({ name: `Pending Org One ${Date.now()}-${Math.random()}` });
    const orgTwo = await organizationRepository.create({ name: `Pending Org Two ${Date.now()}-${Math.random()}` });
    organizationId = orgOne.id;
    const deviceOne = await setUpDeviceConversation("One");

    organizationId = orgTwo.id;
    const deviceTwo = await setUpDeviceConversation("Two");
    await queueOutboundMessage(deviceTwo.conversation.id, "Org two message");

    const pendingForDeviceOne = await listPendingMessagesForDevice(deviceOne.channelAccount);
    expect(pendingForDeviceOne).toHaveLength(0);

    // cleanup both orgs
    organizationId = orgOne.id;
    await prisma.organization.deleteMany({ where: { id: orgOne.id } });
    organizationId = orgTwo.id;
  });

  it("offline queueing: messages queued with no recent device heartbeat simply accumulate and are returned once polled", async () => {
    const organization = await organizationRepository.create({ name: `Offline Queue Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const device = await setUpDeviceConversation("Offline");
    // Never heartbeated (lastHeartbeatAt stays null) — simulates a device that's been off.
    expect(device.channelAccount.lastHeartbeatAt).toBeNull();

    const first = await queueOutboundMessage(device.conversation.id, "Queued while offline #1");
    const second = await queueOutboundMessage(device.conversation.id, "Queued while offline #2");

    // The device "comes back online" and polls — both messages queued while it was dark
    // are returned, oldest first, with no special "offline" bookkeeping required.
    const pending = await listPendingMessagesForDevice(device.channelAccount);
    expect(pending.map((m) => m.id)).toEqual([first.id, second.id]);
  });
});

describe("acknowledgeMessage", () => {
  it("transitions QUEUED -> SENT and records exactly one MessageEvent, even when called twice", async () => {
    const organization = await organizationRepository.create({ name: `Ack Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const device = await setUpDeviceConversation("Ack");
    const message = await queueOutboundMessage(device.conversation.id);
    expect(message.status).toBe("QUEUED");

    const first = await acknowledgeMessage(device.channelAccount, message.id, "device-sms-ref-1");
    expect(first.status).toBe("SENT");

    const second = await acknowledgeMessage(device.channelAccount, message.id, "device-sms-ref-1");
    expect(second.status).toBe("SENT");

    const events = await messageEventRepository.listByMessage(organizationId, message.id);
    const ackEvents = events.filter((e) => e.eventType === "device_acknowledged");
    expect(ackEvents).toHaveLength(1);
  });

  it("is idempotent even without a device-supplied externalMessageId on either call", async () => {
    const organization = await organizationRepository.create({ name: `Ack No Ref Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const device = await setUpDeviceConversation("AckNoRef");
    const message = await queueOutboundMessage(device.conversation.id);

    await acknowledgeMessage(device.channelAccount, message.id, undefined);
    await acknowledgeMessage(device.channelAccount, message.id, undefined);

    const events = await messageEventRepository.listByMessage(organizationId, message.id);
    expect(events.filter((e) => e.eventType === "device_acknowledged")).toHaveLength(1);
  });

  it("throws NotFoundError when a different device tries to acknowledge a message it doesn't own", async () => {
    const organization = await organizationRepository.create({ name: `Ack Cross Device Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const deviceA = await setUpDeviceConversation("CrossA");
    const deviceB = await setUpDeviceConversation("CrossB");
    const message = await queueOutboundMessage(deviceA.conversation.id);

    await expect(acknowledgeMessage(deviceB.channelAccount, message.id, undefined)).rejects.toThrow();
  });
});

describe("failMessage", () => {
  it("schedules a retry for a transient reason (message stays FAILED, a retry_scheduled event exists)", async () => {
    const organization = await organizationRepository.create({ name: `Fail Transient Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const device = await setUpDeviceConversation("FailTransient");
    const message = await queueOutboundMessage(device.conversation.id);

    const result = await failMessage(device.channelAccount, message.id, "NO_SIGNAL");
    expect(result.message.status).toBe("FAILED");

    const events = await messageEventRepository.listByMessage(organizationId, message.id);
    expect(events.some((e) => e.eventType === "retry_scheduled")).toBe(true);
    expect(events.some((e) => e.eventType === "dead_letter")).toBe(false);
  });

  it("goes straight to FAILED with no retry scheduled for a permanent reason", async () => {
    const organization = await organizationRepository.create({ name: `Fail Permanent Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const device = await setUpDeviceConversation("FailPermanent");
    const message = await queueOutboundMessage(device.conversation.id);

    const result = await failMessage(device.channelAccount, message.id, "INVALID_NUMBER");
    expect(result.message.status).toBe("FAILED");

    const events = await messageEventRepository.listByMessage(organizationId, message.id);
    expect(events.some((e) => e.eventType === "retry_scheduled")).toBe(false);
  });
});
