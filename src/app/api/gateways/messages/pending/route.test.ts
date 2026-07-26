/**
 * Route-handler-level tests for `GET /api/gateways/messages/pending` — device-token
 * authenticated, org/device-scoped.
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
const { sendMessage } = await import("@/server/messaging/outboundService");
const { AndroidSmsAdapter } = await import("@/server/channels/androidSms/adapter");
const { issueDeviceToken, hashDeviceToken } = await import("@/server/gateways/androidAuth");
const { gatewayDeviceRateLimiter } = await import("@/server/rateLimit");
const { GET } = await import("./route");

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

async function registerDeviceWithConversation(suffix: string) {
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
  return { channelAccount, conversation, token };
}

function buildRequest(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://example.com/api/gateways/messages/pending", { headers });
}

describe("GET /api/gateways/messages/pending — auth", () => {
  it("rejects with 401 for a missing token", async () => {
    const res = await GET(buildRequest(null));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/gateways/messages/pending — isolation & content", () => {
  it("returns only this device's QUEUED messages, oldest first", async () => {
    const organization = await organizationRepository.create({ name: `Pending Route Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const deviceA = await registerDeviceWithConversation("A");
    const deviceB = await registerDeviceWithConversation("B");

    const m1 = await sendMessage({ organizationId, conversationId: deviceA.conversation.id, text: "first" }, { adapter });
    const m2 = await sendMessage({ organizationId, conversationId: deviceA.conversation.id, text: "second" }, { adapter });
    await sendMessage({ organizationId, conversationId: deviceB.conversation.id, text: "not for A" }, { adapter });

    const res = await GET(buildRequest(deviceA.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string; to: string | null; text: string }> };
    expect(body.messages.map((m) => m.id)).toEqual([m1.message.id, m2.message.id]);
    expect(body.messages[0].to).toBe("+1555ctA");
  });

  it("respects the ?limit= override, capped at 100", async () => {
    const organization = await organizationRepository.create({ name: `Pending Limit Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const device = await registerDeviceWithConversation("Limit");
    await sendMessage({ organizationId, conversationId: device.conversation.id, text: "one" }, { adapter });
    await sendMessage({ organizationId, conversationId: device.conversation.id, text: "two" }, { adapter });

    const req = new Request("https://example.com/api/gateways/messages/pending?limit=1", {
      headers: { authorization: `Bearer ${device.token}` },
    });
    const res = await GET(req);
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(1);
  });

  it("rejects an invalid ?limit= with 400", async () => {
    const organization = await organizationRepository.create({ name: `Pending Bad Limit Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const device = await registerDeviceWithConversation("BadLimit");
    const req = new Request("https://example.com/api/gateways/messages/pending?limit=9999", {
      headers: { authorization: `Bearer ${device.token}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});
