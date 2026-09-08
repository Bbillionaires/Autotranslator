/**
 * Tests for the Telegram Server Actions (`getTelegramWebhookConfig`, `getTelegramHealthStatus`,
 * `registerTelegramWebhook`), rewritten for per-organization bot credentials. `../auth`'s
 * `auth()` is mocked so these tests don't need a real sign-in flow; success paths run against
 * a REAL Postgres test database (see src/server/messaging/__tests__/testDb.ts) since they
 * write a `ChannelAccount` row. No live Telegram API call is ever made — `global.fetch` is
 * mocked throughout.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.TELEGRAM_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY = "cd".repeat(32);
process.env.APP_URL = "https://app.example.com";

vi.mock("../auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

// See src/server/actions/contacts.test.ts for why `auth` is cast to a single signature here.
const auth = (await import("../auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { userRepository } = await import("../repositories/userRepository");
const { registerChannelAdapters } = await import("../channels");
const { decryptTelegramCredentials } = await import("../channels/telegram/credentials");
const { getTelegramWebhookConfig, getTelegramHealthStatus, registerTelegramWebhook } = await import("./telegram");

registerChannelAdapters();

function fakeSession(role: Session["user"]["role"], organizationId = "org1", userId = "u1"): Session {
  return { user: { id: userId, organizationId, role }, expires: "" } as Session;
}

function stubTelegramFetch(botId = 555) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    void init;
    if (String(url).includes("/setWebhook")) {
      return new Response(JSON.stringify({ ok: true, description: "Webhook was set" }), { status: 200 });
    }
    if (String(url).includes("/getMe")) {
      return new Response(JSON.stringify({ ok: true, result: { id: botId, username: "my_bot", first_name: "Bot" } }), { status: 200 });
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(() => {
  vi.mocked(auth).mockReset();
  vi.unstubAllGlobals();
});

describe("getTelegramWebhookConfig", () => {
  it("rejects a session below Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT"));
    const result = await getTelegramWebhookConfig();
    expect(result.ok).toBe(false);
  });

  it("reports not-connected and a null webhookUrl for an org with no Telegram bot yet", async () => {
    const organization = await organizationRepository.create({ name: `Telegram Config Test Org ${Date.now()}-${Math.random()}` });
    try {
      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organization.id));
      const result = await getTelegramWebhookConfig();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.connected).toBe(false);
      expect(result.data.webhookUrl).toBeNull();
      expect(result.data.telegramEnabled).toBe(true);
      expect(result.data.instructions.length).toBeGreaterThan(0);
    } finally {
      await prisma.organization.delete({ where: { id: organization.id } });
    }
  });
});

describe("getTelegramHealthStatus", () => {
  it("rejects a session below Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT"));
    const result = await getTelegramHealthStatus();
    expect(result.ok).toBe(false);
  });

  it("reports not-connected when the org has no Telegram ChannelAccount yet", async () => {
    const organization = await organizationRepository.create({ name: `Telegram Health Test Org ${Date.now()}-${Math.random()}` });
    try {
      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organization.id));
      const result = await getTelegramHealthStatus();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.enabled).toBe(true);
      expect(result.data.connected).toBe(false);
      expect(result.data.healthy).toBe(false);
    } finally {
      await prisma.organization.delete({ where: { id: organization.id } });
    }
  });
});

describe("registerTelegramWebhook", () => {
  let organizationId: string;

  afterEach(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      organizationId = "";
    }
  });

  it("rejects a session below Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT"));
    const result = await registerTelegramWebhook({ botToken: "irrelevant" });
    expect(result.ok).toBe(false);
  });

  it("validates the pasted bot token via getMe, creates a ChannelAccount, and registers the per-account webhook URL", async () => {
    const organization = await organizationRepository.create({ name: `Telegram Action Test Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const actingUser = await userRepository.create({
      organizationId,
      name: "Acting Admin",
      email: `acting-admin-${Date.now()}-${Math.random()}@test.dev`,
      role: "ADMINISTRATOR",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, actingUser.id));

    const fetchMock = stubTelegramFetch(555);
    vi.stubGlobal("fetch", fetchMock);

    const result = await registerTelegramWebhook({ botToken: "real-bot-token-abc" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.webhookUrl).toMatch(/\/api\/channels\/telegram\/webhook\/.+/);
    expect(result.data.webhookUrl).not.toBe("https://app.example.com/api/channels/telegram/webhook");

    const accounts = await channelAccountRepository.listByChannelType(organizationId, "TELEGRAM");
    expect(accounts).toHaveLength(1);
    expect(accounts[0].externalAccountId).toBe("555");
    expect(accounts[0].status).toBe("ACTIVE");
    expect(result.data.webhookUrl).toBe(`https://app.example.com/api/channels/telegram/webhook/${accounts[0].id}`);

    // The stored credentials genuinely encrypt the pasted bot token (round-trips back out).
    const decrypted = decryptTelegramCredentials(accounts[0]);
    expect(decrypted.botToken).toBe("real-bot-token-abc");
    expect(decrypted.webhookSecret.length).toBeGreaterThan(10);

    const setWebhookCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/setWebhook"));
    expect(setWebhookCall).toBeDefined();
    const body = JSON.parse((setWebhookCall![1] as RequestInit).body as string) as { url: string; secret_token: string };
    expect(body.url).toBe(result.data.webhookUrl);
    expect(body.secret_token).toBe(decrypted.webhookSecret);

    // Channel account connect is audited.
    const auditRows = await prisma.auditLog.findMany({ where: { organizationId, entityType: "ChannelAccount" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("channel_account.connected");
  });

  it("rejects an invalid bot token (getMe fails) before creating any ChannelAccount", async () => {
    const organization = await organizationRepository.create({ name: `Telegram Invalid Token Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 })),
    );

    const result = await registerTelegramWebhook({ botToken: "bogus-token" });
    expect(result.ok).toBe(false);

    const accounts = await channelAccountRepository.listByChannelType(organizationId, "TELEGRAM");
    expect(accounts).toHaveLength(0);
  });

  it("cross-org: two different organizations can each register their own distinct bot", async () => {
    const orgA = await organizationRepository.create({ name: `Telegram Cross Org A ${Date.now()}-${Math.random()}` });
    const orgB = await organizationRepository.create({ name: `Telegram Cross Org B ${Date.now()}-${Math.random()}` });

    try {
      const adminA = await userRepository.create({
        organizationId: orgA.id,
        name: "Admin A",
        email: `admin-a-${Date.now()}-${Math.random()}@test.dev`,
        role: "ADMINISTRATOR",
      });
      const adminB = await userRepository.create({
        organizationId: orgB.id,
        name: "Admin B",
        email: `admin-b-${Date.now()}-${Math.random()}@test.dev`,
        role: "ADMINISTRATOR",
      });

      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", orgA.id, adminA.id));
      vi.stubGlobal("fetch", stubTelegramFetch(111));
      const resultA = await registerTelegramWebhook({ botToken: "org-a-bot-token" });
      expect(resultA.ok).toBe(true);

      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", orgB.id, adminB.id));
      vi.stubGlobal("fetch", stubTelegramFetch(222));
      const resultB = await registerTelegramWebhook({ botToken: "org-b-bot-token" });
      expect(resultB.ok).toBe(true);

      if (!resultA.ok || !resultB.ok) return;
      // Distinct webhook URLs, distinct ChannelAccounts, each isolated to its own org.
      expect(resultA.data.webhookUrl).not.toBe(resultB.data.webhookUrl);

      const orgAAccounts = await channelAccountRepository.listByChannelType(orgA.id, "TELEGRAM");
      const orgBAccounts = await channelAccountRepository.listByChannelType(orgB.id, "TELEGRAM");
      expect(orgAAccounts).toHaveLength(1);
      expect(orgBAccounts).toHaveLength(1);
      expect(orgAAccounts[0].externalAccountId).toBe("111");
      expect(orgBAccounts[0].externalAccountId).toBe("222");

      // Each org's stored credentials decrypt to ITS OWN bot token, never the other org's.
      expect(decryptTelegramCredentials(orgAAccounts[0]).botToken).toBe("org-a-bot-token");
      expect(decryptTelegramCredentials(orgBAccounts[0]).botToken).toBe("org-b-bot-token");
    } finally {
      await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    }
  });

  it("the same-bot-id conflict is still rejected: a second organization cannot connect the exact same bot another org already has ACTIVE", async () => {
    const orgA = await organizationRepository.create({ name: `Telegram Same Bot Org A ${Date.now()}-${Math.random()}` });
    const orgB = await organizationRepository.create({ name: `Telegram Same Bot Org B ${Date.now()}-${Math.random()}` });

    try {
      const adminA = await userRepository.create({
        organizationId: orgA.id,
        name: "Admin A",
        email: `admin-a2-${Date.now()}-${Math.random()}@test.dev`,
        role: "ADMINISTRATOR",
      });
      const adminB = await userRepository.create({
        organizationId: orgB.id,
        name: "Admin B",
        email: `admin-b2-${Date.now()}-${Math.random()}@test.dev`,
        role: "ADMINISTRATOR",
      });

      const sharedBotId = 999333;

      // Org A connects a bot with id `sharedBotId` first — succeeds.
      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", orgA.id, adminA.id));
      vi.stubGlobal("fetch", stubTelegramFetch(sharedBotId));
      const first = await registerTelegramWebhook({ botToken: "shared-bot-real-token" });
      expect(first.ok).toBe(true);

      // Org B pastes the SAME bot's token (getMe resolves to the same bot id) — must be
      // hard-rejected (DB-level unique constraint on (channelType, externalAccountId)), and
      // must not create a ChannelAccount for Org B.
      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", orgB.id, adminB.id));
      vi.stubGlobal("fetch", stubTelegramFetch(sharedBotId));
      const second = await registerTelegramWebhook({ botToken: "shared-bot-real-token" });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.message).toMatch(/already connected to another organization/i);
        expect(second.code).toBe("CONFLICT");
      }

      const orgBAccounts = await channelAccountRepository.listByChannelType(orgB.id, "TELEGRAM");
      expect(orgBAccounts).toHaveLength(0);

      const orgAAccounts = await channelAccountRepository.listByChannelType(orgA.id, "TELEGRAM");
      expect(orgAAccounts).toHaveLength(1);
      expect(orgAAccounts[0].status).toBe("ACTIVE");
    } finally {
      await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    }
  });

  it("surfaces an UpstreamAdapterError-derived message when Telegram's setWebhook call fails, leaving the ChannelAccount at PENDING_SETUP (not ACTIVE) for a later retry", async () => {
    const organization = await organizationRepository.create({ name: `Telegram Action Test Org Fail ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/getMe")) {
          return new Response(JSON.stringify({ ok: true, result: { id: 777, username: "flaky_bot", first_name: "Bot" } }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 });
      }),
    );

    const result = await registerTelegramWebhook({ botToken: "flaky-bot-token" });
    expect(result.ok).toBe(false);

    const accounts = await channelAccountRepository.listByChannelType(organizationId, "TELEGRAM");
    expect(accounts).toHaveLength(1);
    expect(accounts[0].status).toBe("PENDING_SETUP");
  });
});
