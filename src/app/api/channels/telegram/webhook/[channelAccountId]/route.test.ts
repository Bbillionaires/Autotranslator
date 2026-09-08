/**
 * Route-handler-level tests for `POST /api/channels/telegram/webhook/:channelAccountId`, run
 * against a REAL Postgres test database (see src/server/messaging/__tests__/testDb.ts) — same
 * pattern as Phase 5's inboundService.test.ts/outboundService.test.ts. Telegram API calls the
 * route makes for bot-command replies (`sendMessage`/`answerCallbackQuery`) are mocked via
 * `global.fetch`; no live network call is ever made.
 *
 * Covers the Builder task's explicit requirement: a genuine ADVERSARIAL cross-organization
 * isolation test (org A's webhook never processes as org B and vice versa), not just a
 * happy path — see "cross-org isolation" describe block below.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.TELEGRAM_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);

const { prisma } = await import("@/server/db");
const { organizationRepository } = await import("@/server/repositories/organizationRepository");
const { channelAccountRepository } = await import("@/server/repositories/channelAccountRepository");
const { contactChannelIdentityRepository } = await import("@/server/repositories/contactChannelIdentityRepository");
const { registerChannelAdapters } = await import("@/server/channels");
const { encryptTelegramCredentials } = await import("@/server/channels/telegram/credentials");
const { WEBHOOK_RATE_LIMIT } = await import("@/server/rateLimit");
const { POST } = await import("./route");

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

async function setUpOrgAndChannel(opts: { botId?: number; webhookSecret?: string; orgName?: string } = {}) {
  const organization = await organizationRepository.create({
    name: opts.orgName ?? `Telegram Webhook Test Org ${Date.now()}-${Math.random()}`,
  });
  organizationIds.push(organization.id);
  const webhookSecret = opts.webhookSecret ?? `secret-${organization.id}`;
  const botId = opts.botId ?? Math.floor(Math.random() * 1_000_000_000);
  const channelAccount = await channelAccountRepository.create(organization.id, {
    channelType: "TELEGRAM",
    displayName: "Test Telegram Bot",
    externalAccountId: String(botId),
    encryptedCredentials: encryptTelegramCredentials({ botToken: `bot-token-${botId}`, webhookSecret }),
    status: "ACTIVE",
  });
  return { organization, channelAccount, webhookSecret };
}

function buildRequest(channelAccountId: string, body: unknown, secret: string | null, ip?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  if (ip) headers["X-Forwarded-For"] = ip;
  return new Request(`https://example.com/api/channels/telegram/webhook/${channelAccountId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function invoke(channelAccountId: string, body: unknown, secret: string | null, ip?: string) {
  return POST(buildRequest(channelAccountId, body, secret, ip), { params: Promise.resolve({ channelAccountId }) });
}

const now = () => Math.floor(Date.now() / 1000);

describe("POST /api/channels/telegram/webhook/:channelAccountId — webhook validation", () => {
  it("rejects a webhook with the wrong secret token for this specific account (401, no DB write)", async () => {
    const { channelAccount } = await setUpOrgAndChannel();
    const res = await invoke(channelAccount.id, { update_id: 1 }, "wrong-secret");
    expect(res.status).toBe(401);
  });

  it("rejects a webhook with no secret token header at all (401)", async () => {
    const { channelAccount } = await setUpOrgAndChannel();
    const res = await invoke(channelAccount.id, { update_id: 1 }, null);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown channelAccountId", async () => {
    const res = await invoke("does-not-exist", { update_id: 1 }, "anything");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a channelAccountId that exists but belongs to a different channel type", async () => {
    const organization = await organizationRepository.create({ name: `Non-Telegram Org ${Date.now()}` });
    organizationIds.push(organization.id);
    const androidAccount = await channelAccountRepository.create(organization.id, {
      channelType: "ANDROID_SMS",
      displayName: "Not a Telegram bot",
      status: "ACTIVE",
    });
    const res = await invoke(androidAccount.id, { update_id: 1 }, "anything");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a channelAccountId that is PENDING_SETUP (not yet ACTIVE)", async () => {
    const organization = await organizationRepository.create({ name: `Pending Telegram Org ${Date.now()}` });
    organizationIds.push(organization.id);
    const pending = await channelAccountRepository.create(organization.id, {
      channelType: "TELEGRAM",
      displayName: "Pending bot",
      externalAccountId: "999",
      encryptedCredentials: encryptTelegramCredentials({ botToken: "x", webhookSecret: "y" }),
      status: "PENDING_SETUP",
    });
    const res = await invoke(pending.id, { update_id: 1 }, "y");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/channels/telegram/webhook/:channelAccountId — H2 rate limiting", () => {
  it("returns 429 once a single IP exceeds the webhook rate limit, before any signature validation runs", async () => {
    const { channelAccount } = await setUpOrgAndChannel();
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;

    for (let i = 0; i < WEBHOOK_RATE_LIMIT.limit; i++) {
      const res = await invoke(channelAccount.id, { update_id: i }, "wrong-secret", ip);
      expect(res.status).toBe(401);
    }

    const limited = await invoke(channelAccount.id, { update_id: 9999 }, "wrong-secret", ip);
    expect(limited.status).toBe(429);
  });
});

describe("POST /api/channels/telegram/webhook/:channelAccountId — regular messages", () => {
  it("processes a regular text message end-to-end (200; translated Message row created via processInboundMessage)", async () => {
    const { channelAccount, webhookSecret } = await setUpOrgAndChannel();
    const update = {
      update_id: 100,
      message: {
        message_id: 501,
        from: { id: 2001, username: "bob" },
        chat: { id: 2001, type: "private" },
        text: "Hello there",
        date: now(),
      },
    };

    const res = await invoke(channelAccount.id, update, webhookSecret);
    expect(res.status).toBe(200);

    const messages = await prisma.message.findMany({ where: { channelType: "TELEGRAM", organizationId: channelAccount.organizationId } });
    expect(messages).toHaveLength(1);
    expect(messages[0].originalText).toBe("Hello there");
    expect(messages[0].translatedText).toBe("Hello there"); // noop echoes input
    expect(messages[0].direction).toBe("INBOUND");
    expect(messages[0].status).toBe("DELIVERED");

    const identity = await contactChannelIdentityRepository.findByChannelAndExternalId(
      channelAccount.organizationId,
      channelAccount.id,
      "2001",
    );
    expect(identity).not.toBeNull();
  });

  it("a duplicate webhook delivery (the same update sent twice) results in exactly one Message row", async () => {
    const { channelAccount, webhookSecret } = await setUpOrgAndChannel();
    const update = {
      update_id: 200,
      message: { message_id: 777, chat: { id: 3001, type: "private" }, text: "dup test", date: now() },
    };

    const first = await invoke(channelAccount.id, update, webhookSecret);
    const second = await invoke(channelAccount.id, update, webhookSecret);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const messages = await prisma.message.findMany({
      where: { organizationId: channelAccount.organizationId, originalText: "dup test" },
    });
    expect(messages).toHaveLength(1);
  });
});

describe("POST /api/channels/telegram/webhook/:channelAccountId — cross-org isolation (adversarial)", () => {
  it("org A's webhook secret never validates against org B's channelAccountId, and vice versa", async () => {
    const a = await setUpOrgAndChannel({ orgName: `Org A ${Date.now()}` });
    const b = await setUpOrgAndChannel({ orgName: `Org B ${Date.now()}` });

    // Org A's secret against Org B's URL: rejected.
    const crossA = await invoke(b.channelAccount.id, { update_id: 1 }, a.webhookSecret);
    expect(crossA.status).toBe(401);

    // Org B's secret against Org A's URL: rejected.
    const crossB = await invoke(a.channelAccount.id, { update_id: 2 }, b.webhookSecret);
    expect(crossB.status).toBe(401);

    // No message was ever created under either org from the rejected cross-account attempts.
    const messageCount = await prisma.message.count({
      where: { organizationId: { in: [a.organization.id, b.organization.id] } },
    });
    expect(messageCount).toBe(0);
  });

  it("a message delivered to org A's URL with org A's own secret is stored under org A only — never visible to org B", async () => {
    const a = await setUpOrgAndChannel({ orgName: `Org A Isolation ${Date.now()}` });
    const b = await setUpOrgAndChannel({ orgName: `Org B Isolation ${Date.now()}` });

    const update = {
      update_id: 300,
      message: { message_id: 42, chat: { id: 7001, type: "private" }, text: "isolated message", date: now() },
    };

    const res = await invoke(a.channelAccount.id, update, a.webhookSecret);
    expect(res.status).toBe(200);

    const orgAMessages = await prisma.message.findMany({ where: { organizationId: a.organization.id } });
    expect(orgAMessages).toHaveLength(1);
    expect(orgAMessages[0].originalText).toBe("isolated message");

    const orgBMessages = await prisma.message.findMany({ where: { organizationId: b.organization.id } });
    expect(orgBMessages).toHaveLength(0);

    // Same external contact id (7001) delivered to org B's own URL/secret creates an
    // INDEPENDENT Contact/Message under org B — proving the two orgs' Telegram traffic
    // never merges even when the same chat id happens to message both bots.
    const updateForB = {
      update_id: 301,
      message: { message_id: 43, chat: { id: 7001, type: "private" }, text: "message to org B", date: now() },
    };
    const resB = await invoke(b.channelAccount.id, updateForB, b.webhookSecret);
    expect(resB.status).toBe(200);

    const orgBMessagesAfter = await prisma.message.findMany({ where: { organizationId: b.organization.id } });
    expect(orgBMessagesAfter).toHaveLength(1);
    expect(orgBMessagesAfter[0].originalText).toBe("message to org B");

    // Org A's message count is unaffected by org B's delivery.
    const orgAMessagesAfter = await prisma.message.findMany({ where: { organizationId: a.organization.id } });
    expect(orgAMessagesAfter).toHaveLength(1);
  });

  it("the same bot id can never be ACTIVE under two different organizations (DB-level unique constraint)", async () => {
    const sharedBotId = Math.floor(Math.random() * 1_000_000_000);
    const a = await setUpOrgAndChannel({ orgName: `Shared Bot Org A ${Date.now()}`, botId: sharedBotId });
    void a;

    const orgB = await organizationRepository.create({ name: `Shared Bot Org B ${Date.now()}` });
    organizationIds.push(orgB.id);

    await expect(
      channelAccountRepository.create(orgB.id, {
        channelType: "TELEGRAM",
        displayName: "Org B's attempt to claim the same bot",
        externalAccountId: String(sharedBotId),
        encryptedCredentials: encryptTelegramCredentials({ botToken: "whatever", webhookSecret: "whatever" }),
        status: "ACTIVE",
      }),
    ).rejects.toThrow();
  });
});

describe("POST /api/channels/telegram/webhook/:channelAccountId — bot command interception", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function stubTelegramFetch() {
    let nextMessageId = 9000;
    fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/answerCallbackQuery")) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  it("/start greets the user and creates a Contact, without storing a chat Message", async () => {
    stubTelegramFetch();
    const { channelAccount, webhookSecret } = await setUpOrgAndChannel();
    const update = {
      update_id: 300,
      message: { message_id: 1, from: { id: 4001, username: "carol" }, chat: { id: 4001, type: "private" }, text: "/start", date: now() },
    };

    const res = await invoke(channelAccount.id, update, webhookSecret);
    expect(res.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sendMessage");
    const sentBody = JSON.parse(init.body as string) as { chat_id: string; text: string };
    expect(sentBody.chat_id).toBe("4001");
    expect(sentBody.text).toMatch(/welcome/i);

    const messageCount = await prisma.message.count({ where: { organizationId: channelAccount.organizationId, channelType: "TELEGRAM" } });
    expect(messageCount).toBe(0);

    const contact = await prisma.contact.findFirst({ where: { organizationId: channelAccount.organizationId, displayName: "carol" } });
    expect(contact).not.toBeNull();
  });

  it("a callback_query language selection sets Contact.preferredLanguage and answers the callback query, using this account's own bot token", async () => {
    stubTelegramFetch();
    const { channelAccount, webhookSecret } = await setUpOrgAndChannel();
    const update = {
      update_id: 304,
      callback_query: {
        id: "cbq-1",
        from: { id: 4005, username: "dave" },
        message: { message_id: 10, chat: { id: 4005, type: "private" }, date: now() },
        data: "lang:es",
      },
    };

    const res = await invoke(channelAccount.id, update, webhookSecret);
    expect(res.status).toBe(200);

    const answerCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/answerCallbackQuery"));
    expect(answerCall).toBeDefined();
    // The bot token embedded in the outbound request URL is THIS account's own decrypted
    // token (`bot-token-${externalAccountId}`, per setUpOrgAndChannel's fixture) — proves
    // the route used the account resolved from the URL, not some other account's token.
    const [answerUrl] = answerCall as [string, RequestInit];
    expect(String(answerUrl)).toContain(`bot-token-${channelAccount.externalAccountId}`);
    const sendCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/sendMessage"));
    expect(sendCall).toBeDefined();
    const [sendUrl] = sendCall as [string, RequestInit];
    expect(String(sendUrl)).toContain(`bot-token-${channelAccount.externalAccountId}`);

    const identity = await contactChannelIdentityRepository.findByChannelAndExternalId(
      channelAccount.organizationId,
      channelAccount.id,
      "4005",
    );
    expect(identity).not.toBeNull();
    const contact = await prisma.contact.findUnique({ where: { id: identity!.contactId } });
    expect(contact?.preferredLanguage).toBe("es");
  });

  it("an unrecognized command replies with the help text instead of silently failing", async () => {
    stubTelegramFetch();
    const { channelAccount, webhookSecret } = await setUpOrgAndChannel();
    const update = { update_id: 305, message: { message_id: 5, chat: { id: 4006, type: "private" }, text: "/nonsense", date: now() } };

    const res = await invoke(channelAccount.id, update, webhookSecret);
    expect(res.status).toBe(200);
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { text: string };
    expect(sentBody.text).toContain("/help");
  });
});
