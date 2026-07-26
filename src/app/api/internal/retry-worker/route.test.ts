/**
 * Tests for `GET`/`POST /api/internal/retry-worker` (H4 fix, docs/review-report.md) — the
 * missing entrypoint that actually invokes `runRetryWorkerOnce`. Runs against a REAL
 * Postgres test database (see src/server/messaging/__tests__/testDb.ts) since it needs
 * genuine FAILED `Message` rows with `retry_scheduled` `MessageEvent` history, across
 * multiple organizations (proving the cross-org pass works), and a real channel adapter
 * registered so `retryMessage` can actually resend.
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
const { contactRepository } = await import("@/server/repositories/contactRepository");
const { contactChannelIdentityRepository } = await import("@/server/repositories/contactChannelIdentityRepository");
const { conversationRepository } = await import("@/server/repositories/conversationRepository");
const { messageEventRepository } = await import("@/server/repositories/messageEventRepository");
const { registerChannelAdapters } = await import("@/server/channels");

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

async function setUpFailedMessage(opts: { scheduledForPast: boolean }) {
  const organization = await organizationRepository.create({ name: `Retry Worker Test Org ${Date.now()}-${Math.random()}` });
  organizationIds.push(organization.id);
  const channelAccount = await channelAccountRepository.create(organization.id, {
    channelType: "TELEGRAM",
    displayName: "Test Bot",
    status: "ACTIVE",
  });
  const contact = await contactRepository.create(organization.id, { displayName: "Retry Contact" });
  await contactChannelIdentityRepository.create(organization.id, {
    contactId: contact.id,
    channelAccountId: channelAccount.id,
    externalContactId: `retry-contact-${contact.id}`,
  });
  const conversation = await conversationRepository.upsertForContactAndChannel(organization.id, contact.id, channelAccount.id);

  const message = await prisma.message.create({
    data: {
      organizationId: organization.id,
      conversationId: conversation.id,
      senderType: "USER",
      direction: "OUTBOUND",
      originalText: "Hi",
      translatedText: "Hi",
      channelType: "TELEGRAM",
      status: "FAILED",
      idempotencyKey: `retry-worker-${Date.now()}-${Math.random()}`,
    },
  });

  const scheduledFor = opts.scheduledForPast ? new Date(Date.now() - 60_000) : new Date(Date.now() + 60 * 60_000);
  await messageEventRepository.create({
    messageId: message.id,
    eventType: "retry_scheduled",
    payload: { attempt: 1, scheduledFor: scheduledFor.toISOString() },
  });

  return { organization, channelAccount, message };
}

describe("GET/POST /api/internal/retry-worker — auth", () => {
  it("returns 503 when INTERNAL_WORKER_SECRET is not configured (fails closed, not open)", async () => {
    delete process.env.INTERNAL_WORKER_SECRET;
    vi.resetModules();
    const { GET } = await import("./route");

    const res = await GET(new Request("https://example.com/api/internal/retry-worker"));
    expect(res.status).toBe(503);
  });

  it("returns 401 when the shared-secret header is missing or wrong", async () => {
    process.env.INTERNAL_WORKER_SECRET = "test-worker-secret";
    vi.resetModules();
    const { GET } = await import("./route");

    const missing = await GET(new Request("https://example.com/api/internal/retry-worker"));
    expect(missing.status).toBe(401);

    const wrong = await GET(
      new Request("https://example.com/api/internal/retry-worker", { headers: { "X-Internal-Worker-Secret": "wrong" } }),
    );
    expect(wrong.status).toBe(401);
  });
});

describe("GET/POST /api/internal/retry-worker — processes due retries across organizations", () => {
  it("retries a due FAILED message (past scheduledFor) but skips a not-yet-due one, across two different orgs", async () => {
    process.env.INTERNAL_WORKER_SECRET = "test-worker-secret";
    vi.resetModules();
    // `vi.resetModules()` gives `./route` (and everything it imports, including the channel
    // adapter registry) a FRESH module instance — re-register adapters against that fresh
    // instance before importing the route, or `channelAdapterRegistry.getOrThrow` will find
    // nothing registered.
    const { registerChannelAdapters: registerFreshChannelAdapters } = await import("@/server/channels");
    registerFreshChannelAdapters();
    const { GET, POST } = await import("./route");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 })),
    );

    const due = await setUpFailedMessage({ scheduledForPast: true });
    const notDue = await setUpFailedMessage({ scheduledForPast: false });

    const res = await POST(
      new Request("https://example.com/api/internal/retry-worker", {
        method: "POST",
        headers: { "X-Internal-Worker-Secret": "test-worker-secret" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempted: number; succeeded: number; failed: number };
    expect(body.attempted).toBe(1);
    expect(body.succeeded).toBe(1);

    const dueMessage = await prisma.message.findUniqueOrThrow({ where: { id: due.message.id } });
    expect(dueMessage.status).toBe("SENT"); // successfully re-sent via the (mocked) Telegram adapter

    const notDueMessage = await prisma.message.findUniqueOrThrow({ where: { id: notDue.message.id } });
    expect(notDueMessage.status).toBe("FAILED"); // untouched — not due yet

    // GET works identically to POST (some schedulers only issue GET).
    const getRes = await GET(
      new Request("https://example.com/api/internal/retry-worker", { headers: { "X-Internal-Worker-Secret": "test-worker-secret" } }),
    );
    expect(getRes.status).toBe(200);
  });
});
