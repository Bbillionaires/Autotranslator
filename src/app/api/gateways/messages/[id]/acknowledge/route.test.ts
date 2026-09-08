/**
 * Route-handler-level tests for `POST /api/gateways/messages/:id/acknowledge` —
 * device-token authenticated, idempotent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.ANDROID_GATEWAY_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY ??= "fe".repeat(32);
process.env.ANDROID_GATEWAY_SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

const { prisma } = await import("@/server/db");
const { organizationRepository } = await import("@/server/repositories/organizationRepository");
const { channelAccountRepository } = await import("@/server/repositories/channelAccountRepository");
const { contactRepository } = await import("@/server/repositories/contactRepository");
const { contactChannelIdentityRepository } = await import("@/server/repositories/contactChannelIdentityRepository");
const { conversationRepository } = await import("@/server/repositories/conversationRepository");
const { messageEventRepository } = await import("@/server/repositories/messageEventRepository");
const { sendMessage } = await import("@/server/messaging/outboundService");
const { AndroidSmsAdapter } = await import("@/server/channels/androidSms/adapter");
const { issueDeviceToken, hashDeviceToken } = await import("@/server/gateways/androidAuth");
const { gatewayDeviceRateLimiter } = await import("@/server/rateLimit");
const { POST } = await import("./route");

const adapter = new AndroidSmsAdapter();
let organizationId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  gatewayDeviceRateLimiter.reset();
});

afterEach(async () => {
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

async function registerDeviceWithQueuedMessage(suffix: string) {
  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "ANDROID_SMS",
    displayName: `Device ${suffix}`,
    externalAccountId: `+1555dev${suffix}`,
    status: "ACTIVE",
  });
  const token = issueDeviceToken(channelAccount.id);
  await channelAccountRepository.setDeviceTokenHash(organizationId, channelAccount.id, hashDeviceToken(token));

  const contact = await contactRepository.create(organizationId, { displayName: `Contact ${suffix}`, phoneNumber: `+1555ct${suffix}` });
  await contactChannelIdentityRepository.create(organizationId, {
    contactId: contact.id,
    channelAccountId: channelAccount.id,
    externalContactId: `+1555ct${suffix}`,
    phoneNumber: `+1555ct${suffix}`,
  });
  const conversation = await conversationRepository.upsertForContactAndChannel(organizationId, contact.id, channelAccount.id);
  const { message } = await sendMessage({ organizationId, conversationId: conversation.id, text: "hi" }, { adapter });

  return { channelAccount, token, message };
}

function buildRequest(id: string, body: unknown, token: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`https://example.com/api/gateways/messages/${id}/acknowledge`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/gateways/messages/:id/acknowledge — auth", () => {
  it("rejects with 401 for a missing token", async () => {
    const organization = await organizationRepository.create({ name: `Ack Route Auth Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const { message } = await registerDeviceWithQueuedMessage("Auth");

    const res = await POST(buildRequest(message.id, {}, null), { params: Promise.resolve({ id: message.id }) });
    expect(res.status).toBe(401);
  });

  it("rejects with 401 for a revoked device", async () => {
    const organization = await organizationRepository.create({ name: `Ack Route Revoked Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const { channelAccount, token, message } = await registerDeviceWithQueuedMessage("Revoked");
    await channelAccountRepository.revokeDevice(organizationId, channelAccount.id);

    const res = await POST(buildRequest(message.id, {}, token), { params: Promise.resolve({ id: message.id }) });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/gateways/messages/:id/acknowledge — happy path & idempotency", () => {
  it("transitions QUEUED -> SENT", async () => {
    const organization = await organizationRepository.create({ name: `Ack Route Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const { token, message } = await registerDeviceWithQueuedMessage("Happy");

    const res = await POST(buildRequest(message.id, { externalMessageId: "sms-ref-1" }, token), {
      params: Promise.resolve({ id: message.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.status).toBe("SENT");
  });

  it("is idempotent: calling twice never errors and records exactly one MessageEvent", async () => {
    const organization = await organizationRepository.create({ name: `Ack Route Idempotent Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const { token, message } = await registerDeviceWithQueuedMessage("Idempotent");

    const first = await POST(buildRequest(message.id, {}, token), { params: Promise.resolve({ id: message.id }) });
    const second = await POST(buildRequest(message.id, {}, token), { params: Promise.resolve({ id: message.id }) });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const events = await messageEventRepository.listByMessage(organizationId, message.id);
    expect(events.filter((e) => e.eventType === "device_acknowledged")).toHaveLength(1);
  });

  it("returns 404 for a message belonging to a different device", async () => {
    const organization = await organizationRepository.create({ name: `Ack Route Cross Device Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const deviceA = await registerDeviceWithQueuedMessage("CrossA");
    const deviceB = await registerDeviceWithQueuedMessage("CrossB");

    const res = await POST(buildRequest(deviceA.message.id, {}, deviceB.token), {
      params: Promise.resolve({ id: deviceA.message.id }),
    });
    expect(res.status).toBe(404);
  });
});
