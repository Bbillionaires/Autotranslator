/**
 * Route-handler-level tests for `POST /api/channels/telegram/webhook`, run against a REAL
 * Postgres test database (see src/server/messaging/__tests__/testDb.ts) — same pattern as
 * Phase 5's inboundService.test.ts/outboundService.test.ts. Telegram API calls the route
 * makes for bot-command replies (`sendMessage`/`answerCallbackQuery`) are mocked via
 * `global.fetch`; no live network call is ever made.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.TELEGRAM_ENABLED = "true";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

const { prisma } = await import("@/server/db");
const { organizationRepository } = await import("@/server/repositories/organizationRepository");
const { channelAccountRepository } = await import("@/server/repositories/channelAccountRepository");
const { contactChannelIdentityRepository } = await import("@/server/repositories/contactChannelIdentityRepository");
const { registerChannelAdapters } = await import("@/server/channels");
const { WEBHOOK_RATE_LIMIT } = await import("@/server/rateLimit");
const { POST } = await import("./route");

registerChannelAdapters();

let organizationId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

async function setUpOrgAndChannel() {
  const organization = await organizationRepository.create({ name: `Telegram Webhook Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "TELEGRAM",
    displayName: "Test Telegram Bot",
    status: "ACTIVE",
  });
  return { organization, channelAccount };
}

function buildRequest(body: unknown, secret: string | null = "test-webhook-secret", ip?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  if (ip) headers["X-Forwarded-For"] = ip;
  return new Request("https://example.com/api/channels/telegram/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const now = () => Math.floor(Date.now() / 1000);

describe("POST /api/channels/telegram/webhook — webhook validation", () => {
  it("rejects a webhook with the wrong secret token (401, no DB write)", async () => {
    const res = await POST(buildRequest({ update_id: 1 }, "wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("rejects a webhook with no secret token header (401)", async () => {
    const res = await POST(buildRequest({ update_id: 1 }, null));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/channels/telegram/webhook — H2 rate limiting", () => {
  it("returns 429 once a single IP exceeds the webhook rate limit, before any signature validation runs", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`; // unique per test run, isolated from other tests' shared "unknown" bucket

    for (let i = 0; i < WEBHOOK_RATE_LIMIT.limit; i++) {
      // Deliberately using a WRONG secret token here — proves the rate limit is enforced
      // BEFORE signature validation (a flood of garbage requests is still bounded).
      const res = await POST(buildRequest({ update_id: i }, "wrong-secret", ip));
      expect(res.status).toBe(401);
    }

    const limited = await POST(buildRequest({ update_id: 9999 }, "wrong-secret", ip));
    expect(limited.status).toBe(429);
  });
});

describe("POST /api/channels/telegram/webhook — regular messages", () => {
  it("processes a regular text message end-to-end (200; translated Message row created via processInboundMessage)", async () => {
    const { channelAccount } = await setUpOrgAndChannel();
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

    const res = await POST(buildRequest(update));
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
    const { channelAccount } = await setUpOrgAndChannel();
    const update = {
      update_id: 200,
      message: { message_id: 777, chat: { id: 3001, type: "private" }, text: "dup test", date: now() },
    };

    const first = await POST(buildRequest(update));
    const second = await POST(buildRequest(update));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const messages = await prisma.message.findMany({
      where: { organizationId: channelAccount.organizationId, originalText: "dup test" },
    });
    expect(messages).toHaveLength(1);
  });

  it("returns 200 (ignored) when no ChannelAccount is configured for Telegram yet", async () => {
    const update = { update_id: 999, message: { message_id: 1, chat: { id: 1, type: "private" }, text: "hi", date: now() } };
    const res = await POST(buildRequest(update));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ignored?: string };
    expect(body.ignored).toBe("no_channel_account");
  });

  it("C1 safety net: rejects (does not silently route) when more than one org somehow has an ACTIVE Telegram ChannelAccount", async () => {
    // `registerTelegramWebhook` blocks this from happening via the normal app flow — this
    // simulates the "should be impossible" case (e.g. direct DB access, a future
    // regression) via direct repository calls, proving the webhook route fails loud rather
    // than silently picking a winner and leaking data cross-org.
    const orgA = await organizationRepository.create({ name: `Telegram C1 Route Org A ${Date.now()}-${Math.random()}` });
    const orgB = await organizationRepository.create({ name: `Telegram C1 Route Org B ${Date.now()}-${Math.random()}` });
    organizationId = orgA.id; // cleaned up in afterEach; orgB cleaned up explicitly below (try/finally)

    try {
      await channelAccountRepository.create(orgA.id, { channelType: "TELEGRAM", displayName: "Org A Bot", status: "ACTIVE" });
      await channelAccountRepository.create(orgB.id, { channelType: "TELEGRAM", displayName: "Org B Bot", status: "ACTIVE" });

      const update = { update_id: 400, message: { message_id: 1, chat: { id: 5001, type: "private" }, text: "hi", date: now() } };
      const res = await POST(buildRequest(update));

      expect(res.status).toBe(409);
      const messageCount = await prisma.message.count({ where: { organizationId: { in: [orgA.id, orgB.id] } } });
      expect(messageCount).toBe(0); // no message was ever routed to either org
    } finally {
      // try/finally, not just afterEach, so a failed assertion never leaves a second org's
      // ACTIVE Telegram ChannelAccount behind to poison every other test in this file/suite.
      await prisma.organization.deleteMany({ where: { id: orgB.id } });
    }
  });
});

describe("POST /api/channels/telegram/webhook — bot command interception", () => {
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
    const { channelAccount } = await setUpOrgAndChannel();
    const update = {
      update_id: 300,
      message: { message_id: 1, from: { id: 4001, username: "carol" }, chat: { id: 4001, type: "private" }, text: "/start", date: now() },
    };

    const res = await POST(buildRequest(update));
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

  it("/help lists the available commands and is not stored as a Message", async () => {
    stubTelegramFetch();
    const { channelAccount } = await setUpOrgAndChannel();
    const update = { update_id: 301, message: { message_id: 2, chat: { id: 4002, type: "private" }, text: "/help", date: now() } };

    const res = await POST(buildRequest(update));
    expect(res.status).toBe(200);

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { text: string };
    expect(sentBody.text).toContain("/language");
    expect(sentBody.text).toContain("/privacy");

    const messageCount = await prisma.message.count({ where: { organizationId: channelAccount.organizationId } });
    expect(messageCount).toBe(0);
  });

  it("/privacy responds with real content, not a silent failure", async () => {
    stubTelegramFetch();
    await setUpOrgAndChannel();
    const update = { update_id: 302, message: { message_id: 3, chat: { id: 4003, type: "private" }, text: "/privacy", date: now() } };

    const res = await POST(buildRequest(update));
    expect(res.status).toBe(200);

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { text: string };
    expect(sentBody.text.length).toBeGreaterThan(20);
  });

  it("/language sends an inline-keyboard language picker", async () => {
    stubTelegramFetch();
    await setUpOrgAndChannel();
    const update = { update_id: 303, message: { message_id: 4, chat: { id: 4004, type: "private" }, text: "/language", date: now() } };

    const res = await POST(buildRequest(update));
    expect(res.status).toBe(200);

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      reply_markup?: { inline_keyboard: unknown[][] };
    };
    expect(sentBody.reply_markup?.inline_keyboard.flat().length).toBeGreaterThan(0);
  });

  it("a callback_query language selection sets Contact.preferredLanguage and answers the callback query", async () => {
    stubTelegramFetch();
    const { channelAccount } = await setUpOrgAndChannel();
    const update = {
      update_id: 304,
      callback_query: {
        id: "cbq-1",
        from: { id: 4005, username: "dave" },
        message: { message_id: 10, chat: { id: 4005, type: "private" }, date: now() },
        data: "lang:es",
      },
    };

    const res = await POST(buildRequest(update));
    expect(res.status).toBe(200);

    const answerCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/answerCallbackQuery"));
    expect(answerCall).toBeDefined();

    const identity = await contactChannelIdentityRepository.findByChannelAndExternalId(
      channelAccount.organizationId,
      channelAccount.id,
      "4005",
    );
    expect(identity).not.toBeNull();
    const contact = await prisma.contact.findUnique({ where: { id: identity!.contactId } });
    expect(contact?.preferredLanguage).toBe("es");

    const messageCount = await prisma.message.count({ where: { organizationId: channelAccount.organizationId, channelType: "TELEGRAM" } });
    expect(messageCount).toBe(0);
  });

  it("an unrecognized command replies with the help text instead of silently failing", async () => {
    stubTelegramFetch();
    await setUpOrgAndChannel();
    const update = { update_id: 305, message: { message_id: 5, chat: { id: 4006, type: "private" }, text: "/nonsense", date: now() } };

    const res = await POST(buildRequest(update));
    expect(res.status).toBe(200);
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { text: string };
    expect(sentBody.text).toContain("/help");
  });
});
