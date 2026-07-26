/**
 * Route-handler-level tests for `GET`/`POST /api/channels/whatsapp/webhook`, run against a
 * REAL Postgres test database (same pattern as the Telegram webhook route's tests). No live
 * Graph API call is ever made from these tests (they don't exercise `sendMessage`).
 */
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.WHATSAPP_ENABLED = "true";
process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "waba-id";
process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
process.env.WHATSAPP_APP_SECRET = "test-app-secret";

const { prisma } = await import("@/server/db");
const { organizationRepository } = await import("@/server/repositories/organizationRepository");
const { channelAccountRepository } = await import("@/server/repositories/channelAccountRepository");
const { contactChannelIdentityRepository } = await import("@/server/repositories/contactChannelIdentityRepository");
const { messageEventRepository } = await import("@/server/repositories/messageEventRepository");
const { registerChannelAdapters } = await import("@/server/channels");
const { GET, POST } = await import("./route");

registerChannelAdapters();

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

async function setUpOrgAndChannel(phoneNumberId = "1234567890") {
  const organization = await organizationRepository.create({ name: `WhatsApp Webhook Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "WHATSAPP",
    displayName: "Test WhatsApp number",
    externalAccountId: phoneNumberId,
    status: "ACTIVE",
  });
  return { organization, channelAccount };
}

function signedPostRequest(body: unknown, secret: string | null = "test-app-secret"): Request {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) {
    headers["X-Hub-Signature-256"] = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  }
  return new Request("https://example.com/api/channels/whatsapp/webhook", { method: "POST", headers, body: raw });
}

function inboundMessagePayload(phoneNumberId: string, overrides: { from?: string; id?: string; text?: string } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Maria" }, wa_id: overrides.from ?? "5215512345678" }],
              messages: [
                {
                  from: overrides.from ?? "5215512345678",
                  id: overrides.id ?? "wamid.INBOUND1",
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: overrides.text ?? "Hola, ¿cuándo abren?" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload(phoneNumberId: string, status: "sent" | "delivered" | "read" | "failed", messageId: string, timestamp: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: phoneNumberId },
              statuses: [{ id: messageId, status, timestamp, recipient_id: "5215512345678" }],
            },
          },
        ],
      },
    ],
  };
}

describe("GET /api/channels/whatsapp/webhook — verification handshake", () => {
  it("echoes the challenge with 200 when hub.mode=subscribe and the verify token matches", async () => {
    const req = new Request(
      "https://example.com/api/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345",
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("12345");
  });

  it("returns 403 when the verify token is wrong", async () => {
    const req = new Request(
      "https://example.com/api/channels/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=12345",
    );
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("returns 403 when hub.mode is missing/not 'subscribe'", async () => {
    const req = new Request("https://example.com/api/channels/whatsapp/webhook?hub.verify_token=test-verify-token&hub.challenge=12345");
    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});

describe("POST /api/channels/whatsapp/webhook — signature validation", () => {
  it("rejects a request with no X-Hub-Signature-256 header (401, no DB write)", async () => {
    const res = await POST(signedPostRequest({ object: "whatsapp_business_account", entry: [] }, null));
    expect(res.status).toBe(401);
  });

  it("rejects a request signed with the wrong secret (401)", async () => {
    const res = await POST(signedPostRequest({ object: "whatsapp_business_account", entry: [] }, "wrong-secret"));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/channels/whatsapp/webhook — inbound messages", () => {
  it("processes a regular text message end-to-end (200; translated Message row created)", async () => {
    const { channelAccount } = await setUpOrgAndChannel();
    const res = await POST(signedPostRequest(inboundMessagePayload("1234567890", { text: "Hello there" })));
    expect(res.status).toBe(200);

    const messages = await prisma.message.findMany({ where: { channelType: "WHATSAPP", organizationId: channelAccount.organizationId } });
    expect(messages).toHaveLength(1);
    expect(messages[0].originalText).toBe("Hello there");
    expect(messages[0].translatedText).toBe("Hello there"); // noop echoes input
    expect(messages[0].direction).toBe("INBOUND");
    expect(messages[0].status).toBe("DELIVERED");

    const identity = await contactChannelIdentityRepository.findByChannelAndExternalId(
      channelAccount.organizationId,
      channelAccount.id,
      "5215512345678",
    );
    expect(identity).not.toBeNull();
  });

  it("a duplicate webhook delivery (the same message id sent twice) results in exactly one Message row", async () => {
    const { channelAccount } = await setUpOrgAndChannel();
    const payload = inboundMessagePayload("1234567890", { id: "wamid.DUPTEST1", text: "dup test" });

    const first = await POST(signedPostRequest(payload));
    const second = await POST(signedPostRequest(payload));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const messages = await prisma.message.findMany({
      where: { organizationId: channelAccount.organizationId, originalText: "dup test" },
    });
    expect(messages).toHaveLength(1);
  });

  it("returns 200 (no crash) when no ChannelAccount matches the payload's phone_number_id", async () => {
    const res = await POST(signedPostRequest(inboundMessagePayload("no-such-phone-number-id")));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/channels/whatsapp/webhook — delivery status callbacks", () => {
  it("a delivered then read status callback transitions the Message forward, idempotently", async () => {
    const { channelAccount } = await setUpOrgAndChannel();
    const message = await prisma.message.create({
      data: {
        organizationId: channelAccount.organizationId,
        conversationId: (
          await prisma.conversation.create({
            data: {
              organizationId: channelAccount.organizationId,
              contactId: (
                await prisma.contact.create({ data: { organizationId: channelAccount.organizationId, displayName: "Status Test Contact" } })
              ).id,
              channelAccountId: channelAccount.id,
            },
          })
        ).id,
        senderType: "USER",
        direction: "OUTBOUND",
        originalText: "Hi",
        channelType: "WHATSAPP",
        externalMessageId: "wamid.STATUSFLOW1",
        status: "SENT",
        idempotencyKey: "status-flow-1",
      },
    });

    const deliveredRes = await POST(signedPostRequest(statusPayload("1234567890", "delivered", "wamid.STATUSFLOW1", "1700000000")));
    expect(deliveredRes.status).toBe(200);
    let updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.status).toBe("DELIVERED");

    const readRes = await POST(signedPostRequest(statusPayload("1234567890", "read", "wamid.STATUSFLOW1", "1700000010")));
    expect(readRes.status).toBe(200);
    updated = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.status).toBe("READ");

    // Duplicate delivery of the SAME "delivered" callback (identical id+status+timestamp,
    // as Meta's aggressive webhook retries would send) must not double-record.
    await POST(signedPostRequest(statusPayload("1234567890", "delivered", "wamid.STATUSFLOW1", "1700000000")));
    const events = await messageEventRepository.listByMessage(channelAccount.organizationId, message.id);
    expect(events.filter((e) => e.eventType === "delivered")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "read")).toHaveLength(1);

    // And the duplicate must not have regressed status back from READ.
    const final = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(final.status).toBe("READ");
  });
});
