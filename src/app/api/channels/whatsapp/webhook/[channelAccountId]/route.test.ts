/**
 * Route-handler-level tests for `GET`/`POST /api/channels/whatsapp/webhook/:channelAccountId`,
 * run against a REAL Postgres test database. Covers the Builder task's explicit requirement:
 * a genuine adversarial cross-organization isolation test for the per-account webhook path,
 * and proof that signature validation genuinely uses the right org's own secret.
 */
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.WHATSAPP_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY = "01".repeat(32);

const { prisma } = await import("@/server/db");
const { organizationRepository } = await import("@/server/repositories/organizationRepository");
const { channelAccountRepository } = await import("@/server/repositories/channelAccountRepository");
const { registerChannelAdapters } = await import("@/server/channels");
const { encryptWhatsAppCredentials } = await import("@/server/channels/whatsapp/credentials");
const { WEBHOOK_RATE_LIMIT } = await import("@/server/rateLimit");
const { GET, POST } = await import("./route");

registerChannelAdapters();

let organizationIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    organizationIds = [];
  }
});

async function setUpOrgAndChannel(opts: { phoneNumberId?: string; appSecret?: string; verifyToken?: string; orgName?: string } = {}) {
  const organization = await organizationRepository.create({
    name: opts.orgName ?? `WhatsApp Webhook Test Org ${Date.now()}-${Math.random()}`,
  });
  organizationIds.push(organization.id);
  const phoneNumberId = opts.phoneNumberId ?? String(Math.floor(Math.random() * 1_000_000_000));
  const appSecret = opts.appSecret ?? `app-secret-${organization.id}`;
  const verifyToken = opts.verifyToken ?? `verify-token-${organization.id}`;
  const channelAccount = await channelAccountRepository.create(organization.id, {
    channelType: "WHATSAPP",
    displayName: "Test WhatsApp Account",
    externalAccountId: phoneNumberId,
    encryptedCredentials: encryptWhatsAppCredentials({
      accessToken: `access-token-${phoneNumberId}`,
      phoneNumberId,
      businessAccountId: `waba-${phoneNumberId}`,
      appSecret,
      verifyToken,
    }),
    status: "ACTIVE",
  });
  return { organization, channelAccount, phoneNumberId, appSecret, verifyToken };
}

function signedRequest(channelAccountId: string, body: unknown, appSecret: string): Request {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
  return new Request(`https://example.com/api/channels/whatsapp/webhook/${channelAccountId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
    body: raw,
  });
}

function invokePost(channelAccountId: string, req: Request) {
  return POST(req, { params: Promise.resolve({ channelAccountId }) });
}

function invokeGet(channelAccountId: string, query: string) {
  const req = new Request(`https://example.com/api/channels/whatsapp/webhook/${channelAccountId}?${query}`);
  return GET(req, { params: Promise.resolve({ channelAccountId }) });
}

function messageValue(phoneNumberId: string, waId: string, text: string, messageId: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId },
              messages: [{ from: waId, id: messageId, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

describe("GET /api/channels/whatsapp/webhook/:channelAccountId — verify handshake", () => {
  it("echoes the challenge when hub.verify_token matches THIS account's own verifyToken", async () => {
    const { channelAccount, verifyToken } = await setUpOrgAndChannel();
    const res = await invokeGet(channelAccount.id, `hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=echo-me`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo-me");
  });

  it("rejects a different organization's verify token against this account's URL", async () => {
    const a = await setUpOrgAndChannel({ orgName: `WA Verify Org A ${Date.now()}` });
    const b = await setUpOrgAndChannel({ orgName: `WA Verify Org B ${Date.now()}` });

    const res = await invokeGet(a.channelAccount.id, `hub.mode=subscribe&hub.verify_token=${b.verifyToken}&hub.challenge=echo-me`);
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown channelAccountId", async () => {
    const res = await invokeGet("does-not-exist", "hub.mode=subscribe&hub.verify_token=x&hub.challenge=y");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/channels/whatsapp/webhook/:channelAccountId — signature validation", () => {
  it("accepts a request signed with THIS account's own appSecret", async () => {
    const { channelAccount, phoneNumberId, appSecret } = await setUpOrgAndChannel();
    const req = signedRequest(channelAccount.id, messageValue(phoneNumberId, "5215512345678", "hi", "wamid.1"), appSecret);
    const res = await invokePost(channelAccount.id, req);
    expect(res.status).toBe(200);
  });

  it("rejects a request signed with a DIFFERENT organization's appSecret, even against a valid channelAccountId", async () => {
    const a = await setUpOrgAndChannel({ orgName: `WA Sig Org A ${Date.now()}` });
    const b = await setUpOrgAndChannel({ orgName: `WA Sig Org B ${Date.now()}` });

    const req = signedRequest(a.channelAccount.id, messageValue(a.phoneNumberId, "5215512345678", "hi", "wamid.2"), b.appSecret);
    const res = await invokePost(a.channelAccount.id, req);
    expect(res.status).toBe(401);

    const messageCount = await prisma.message.count({ where: { organizationId: a.organization.id } });
    expect(messageCount).toBe(0);
  });

  it("rejects a tampered body (signature no longer matches)", async () => {
    const { channelAccount, phoneNumberId, appSecret } = await setUpOrgAndChannel();
    const raw = JSON.stringify(messageValue(phoneNumberId, "1", "original", "wamid.3"));
    const signature = `sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`;
    const req = new Request(`https://example.com/api/channels/whatsapp/webhook/${channelAccount.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
      body: JSON.stringify(messageValue(phoneNumberId, "1", "tampered", "wamid.3")),
    });
    const res = await invokePost(channelAccount.id, req);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown channelAccountId", async () => {
    const req = signedRequest("does-not-exist", { object: "whatsapp_business_account", entry: [] }, "whatever");
    const res = await invokePost("does-not-exist", req);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/channels/whatsapp/webhook/:channelAccountId — H2 rate limiting", () => {
  it("returns 429 once a single IP exceeds the webhook rate limit", async () => {
    const { channelAccount } = await setUpOrgAndChannel();
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;

    for (let i = 0; i < WEBHOOK_RATE_LIMIT.limit; i++) {
      const req = signedRequest(channelAccount.id, { object: "whatsapp_business_account", entry: [] }, "wrong-secret");
      req.headers.set("X-Forwarded-For", ip);
      const res = await invokePost(channelAccount.id, req);
      expect(res.status).toBe(401);
    }

    const limitedReq = signedRequest(channelAccount.id, { object: "whatsapp_business_account", entry: [] }, "wrong-secret");
    limitedReq.headers.set("X-Forwarded-For", ip);
    const limited = await invokePost(channelAccount.id, limitedReq);
    expect(limited.status).toBe(429);
  });
});

describe("POST /api/channels/whatsapp/webhook/:channelAccountId — cross-org isolation (adversarial)", () => {
  it("a message delivered to org A's URL with org A's own signature is stored under org A only — never org B", async () => {
    const a = await setUpOrgAndChannel({ orgName: `WA Isolation Org A ${Date.now()}` });
    const b = await setUpOrgAndChannel({ orgName: `WA Isolation Org B ${Date.now()}` });

    const reqA = signedRequest(a.channelAccount.id, messageValue(a.phoneNumberId, "5215500000001", "message for A", "wamid.a1"), a.appSecret);
    const resA = await invokePost(a.channelAccount.id, reqA);
    expect(resA.status).toBe(200);

    const orgAMessages = await prisma.message.findMany({ where: { organizationId: a.organization.id } });
    expect(orgAMessages).toHaveLength(1);
    expect(orgAMessages[0].originalText).toBe("message for A");

    const orgBMessages = await prisma.message.findMany({ where: { organizationId: b.organization.id } });
    expect(orgBMessages).toHaveLength(0);

    // Even the SAME sender waId messaging org B's own number creates an independent
    // Contact/Message under org B — proving the two orgs' WhatsApp traffic never merges.
    const reqB = signedRequest(b.channelAccount.id, messageValue(b.phoneNumberId, "5215500000001", "message for B", "wamid.b1"), b.appSecret);
    const resB = await invokePost(b.channelAccount.id, reqB);
    expect(resB.status).toBe(200);

    const orgBMessagesAfter = await prisma.message.findMany({ where: { organizationId: b.organization.id } });
    expect(orgBMessagesAfter).toHaveLength(1);
    expect(orgBMessagesAfter[0].originalText).toBe("message for B");

    const orgAMessagesAfter = await prisma.message.findMany({ where: { organizationId: a.organization.id } });
    expect(orgAMessagesAfter).toHaveLength(1);
  });

  it("the same phoneNumberId can never be ACTIVE under two different organizations (DB-level unique constraint)", async () => {
    const sharedPhoneNumberId = String(Math.floor(Math.random() * 1_000_000_000));
    await setUpOrgAndChannel({ orgName: `WA Shared Number Org A ${Date.now()}`, phoneNumberId: sharedPhoneNumberId });

    const orgB = await organizationRepository.create({ name: `WA Shared Number Org B ${Date.now()}` });
    organizationIds.push(orgB.id);

    await expect(
      channelAccountRepository.create(orgB.id, {
        channelType: "WHATSAPP",
        displayName: "Org B's attempt to claim the same number",
        externalAccountId: sharedPhoneNumberId,
        encryptedCredentials: encryptWhatsAppCredentials({
          accessToken: "whatever",
          phoneNumberId: sharedPhoneNumberId,
          businessAccountId: "whatever",
          appSecret: "whatever",
          verifyToken: "whatever",
        }),
        status: "ACTIVE",
      }),
    ).rejects.toThrow();
  });
});

describe("POST /api/channels/whatsapp/webhook/:channelAccountId — duplicate delivery", () => {
  it("a duplicate webhook delivery (same message id sent twice) results in exactly one Message row", async () => {
    const { channelAccount, phoneNumberId, appSecret } = await setUpOrgAndChannel();
    const body = messageValue(phoneNumberId, "5215500000099", "dup test", "wamid.dup1");

    const first = await invokePost(channelAccount.id, signedRequest(channelAccount.id, body, appSecret));
    const second = await invokePost(channelAccount.id, signedRequest(channelAccount.id, body, appSecret));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const messages = await prisma.message.findMany({ where: { organizationId: channelAccount.organizationId, originalText: "dup test" } });
    expect(messages).toHaveLength(1);
  });
});
