/**
 * Route-handler-level tests for `POST /api/gateways/messages/:id/fail` — device-token
 * authenticated; transient reasons schedule a retry, permanent reasons go straight to FAILED.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.ANDROID_GATEWAY_ENABLED = "true";
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
  return new Request(`https://example.com/api/gateways/messages/${id}/fail`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /api/gateways/messages/:id/fail — auth", () => {
  it("rejects with 401 for a missing token", async () => {
    const organization = await organizationRepository.create({ name: `Fail Route Auth Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const { message } = await registerDeviceWithQueuedMessage("Auth");

    const res = await POST(buildRequest(message.id, { reason: "NO_SIGNAL" }, null), { params: Promise.resolve({ id: message.id }) });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/gateways/messages/:id/fail — classification", () => {
  it("schedules a retry for a transient reason", async () => {
    const organization = await organizationRepository.create({ name: `Fail Route Transient Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const { token, message } = await registerDeviceWithQueuedMessage("Transient");

    const res = await POST(buildRequest(message.id, { reason: "SIM_ERROR" }, token), { params: Promise.resolve({ id: message.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("FAILED");

    const events = await messageEventRepository.listByMessage(organizationId, message.id);
    expect(events.some((e) => e.eventType === "retry_scheduled")).toBe(true);
  });

  it("goes straight to FAILED with no retry for a permanent reason", async () => {
    const organization = await organizationRepository.create({ name: `Fail Route Permanent Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const { token, message } = await registerDeviceWithQueuedMessage("Permanent");

    const res = await POST(buildRequest(message.id, { reason: "INVALID_NUMBER" }, token), { params: Promise.resolve({ id: message.id }) });
    expect(res.status).toBe(200);

    const events = await messageEventRepository.listByMessage(organizationId, message.id);
    expect(events.some((e) => e.eventType === "retry_scheduled")).toBe(false);
  });

  it("rejects an unrecognized reason with 400", async () => {
    const organization = await organizationRepository.create({ name: `Fail Route Bad Reason Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const { token, message } = await registerDeviceWithQueuedMessage("BadReason");

    const res = await POST(buildRequest(message.id, { reason: "CARRIER_PIGEON_LOST" }, token), {
      params: Promise.resolve({ id: message.id }),
    });
    expect(res.status).toBe(400);
  });
});
