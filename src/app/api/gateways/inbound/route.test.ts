/**
 * Route-handler-level tests for `POST /api/gateways/inbound` — device-token authenticated,
 * per docs/implementation-plan.md §3.5/§5. Uses `TRANSLATION_PROVIDER=noop` (set by
 * `configureTestDatabaseEnv`) so translation is deterministic passthrough with no external
 * API calls, matching the Telegram webhook route test's pattern.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.ANDROID_GATEWAY_ENABLED = "true";
process.env.ANDROID_GATEWAY_SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

const { prisma } = await import("@/server/db");
const { organizationRepository } = await import("@/server/repositories/organizationRepository");
const { channelAccountRepository } = await import("@/server/repositories/channelAccountRepository");
const { issueDeviceToken, hashDeviceToken } = await import("@/server/gateways/androidAuth");
const { gatewayDeviceRateLimiter } = await import("@/server/rateLimit");
const { POST } = await import("./route");

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

async function registerDevice() {
  const organization = await organizationRepository.create({ name: `Inbound Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "ANDROID_SMS",
    displayName: "Inbound device",
    externalAccountId: `+1555in${Math.floor(Math.random() * 10_000_000)}`,
    status: "ACTIVE",
  });
  const token = issueDeviceToken(channelAccount.id);
  await channelAccountRepository.setDeviceTokenHash(organizationId, channelAccount.id, hashDeviceToken(token));
  return { channelAccount, token };
}

function buildRequest(body: unknown, token: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://example.com/api/gateways/inbound", { method: "POST", headers, body: JSON.stringify(body) });
}

const validPayload = {
  from: "+15557654321",
  text: "Necesito ayuda con mi pedido",
  sentAt: "2026-07-26T12:00:00Z",
  externalMessageId: "device-sms-1",
};

describe("POST /api/gateways/inbound — auth", () => {
  it("rejects with 401 for a missing token", async () => {
    const res = await POST(buildRequest(validPayload, null));
    expect(res.status).toBe(401);
  });

  it("rejects with 401 for a revoked device", async () => {
    const { channelAccount, token } = await registerDevice();
    await channelAccountRepository.revokeDevice(organizationId, channelAccount.id);
    const res = await POST(buildRequest(validPayload, token));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/gateways/inbound — processing", () => {
  it("creates a Contact/Conversation/Message end-to-end via processInboundMessage", async () => {
    const { token } = await registerDevice();
    const res = await POST(buildRequest(validPayload, token));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; messageId: string; duplicate: boolean };
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(false);

    const message = await prisma.message.findUniqueOrThrow({ where: { id: body.messageId } });
    expect(message.direction).toBe("INBOUND");
    expect(message.originalText).toBe(validPayload.text);
    // TRANSLATION_PROVIDER=noop passes text through untranslated but still populates translatedText.
    expect(message.translatedText).toBe(validPayload.text);
    expect(message.status).toBe("DELIVERED");

    const contact = await prisma.contact.findFirstOrThrow({ where: { organizationId, phoneNumber: "+15557654321" } });
    expect(contact.displayName).toContain("+15557654321");
  });

  it("dedupes a replayed externalMessageId into the same Message row", async () => {
    const { token } = await registerDevice();
    const first = await POST(buildRequest(validPayload, token));
    const firstBody = (await first.json()) as { messageId: string };

    const second = await POST(buildRequest(validPayload, token));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { messageId: string; duplicate: boolean };

    expect(secondBody.messageId).toBe(firstBody.messageId);
    expect(secondBody.duplicate).toBe(true);

    const count = await prisma.message.count({ where: { organizationId } });
    expect(count).toBe(1);
  });

  it("rejects a malformed payload with 400", async () => {
    const { token } = await registerDevice();
    const res = await POST(buildRequest({ from: "+1555", text: "" }, token));
    expect(res.status).toBe(400);
  });
});
