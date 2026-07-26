/**
 * Tests for the Telegram Server Actions (`getTelegramWebhookConfig`, `getTelegramHealthStatus`,
 * `registerTelegramWebhook`), per docs/implementation-plan.md §5. `../auth`'s `auth()` is
 * mocked so these tests don't need a real sign-in flow; `registerTelegramWebhook`'s success
 * path runs against a REAL Postgres test database (see ./__tests__/testDb.ts-equivalent
 * pattern used by Phase 5's integration tests) since it writes a `ChannelAccount` row. No
 * live Telegram API call is ever made — `global.fetch` is mocked throughout.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.TELEGRAM_ENABLED = "true";
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
process.env.APP_URL = "https://app.example.com";

vi.mock("../auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

// See src/server/actions/contacts.test.ts for why `auth` is cast to a single signature here.
const auth = (await import("../auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { registerChannelAdapters } = await import("../channels");
const { getTelegramWebhookConfig, getTelegramHealthStatus, registerTelegramWebhook } = await import("./telegram");

registerChannelAdapters();

function fakeSession(role: Session["user"]["role"], organizationId = "org1"): Session {
  return { user: { id: "u1", organizationId, role }, expires: "" } as Session;
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

  it("returns the webhook URL (derived from APP_URL) and setup instructions for an Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR"));
    const result = await getTelegramWebhookConfig();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.webhookUrl).toBe("https://app.example.com/api/channels/telegram/webhook");
    expect(result.data.telegramEnabled).toBe(true);
    expect(result.data.instructions.length).toBeGreaterThan(0);
  });
});

describe("getTelegramHealthStatus", () => {
  it("rejects a session below Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT"));
    const result = await getTelegramHealthStatus();
    expect(result.ok).toBe(false);
  });

  it("reports health via the registered adapter (mocked getMe)", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { id: 1, username: "my_bot", first_name: "Bot" } }), { status: 200 })),
    );

    const result = await getTelegramHealthStatus();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.enabled).toBe(true);
    expect(result.data.healthy).toBe(true);
  });
});

describe("registerTelegramWebhook", () => {
  let organizationId: string;

  afterEach(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
  });

  it("rejects a session below Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT"));
    const result = await registerTelegramWebhook();
    expect(result.ok).toBe(false);
  });

  it("calls Telegram's setWebhook and creates a ChannelAccount when none exists yet", async () => {
    const organization = await organizationRepository.create({ name: `Telegram Action Test Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId));

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      void init;
      if (String(url).includes("/setWebhook")) {
        return new Response(JSON.stringify({ ok: true, description: "Webhook was set" }), { status: 200 });
      }
      if (String(url).includes("/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { id: 555, username: "my_bot", first_name: "Bot" } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await registerTelegramWebhook();
    expect(result.ok).toBe(true);

    const accounts = await channelAccountRepository.listByChannelType(organizationId, "TELEGRAM");
    expect(accounts).toHaveLength(1);
    expect(accounts[0].externalAccountId).toBe("555");
    expect(accounts[0].status).toBe("ACTIVE");

    const setWebhookCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/setWebhook"));
    expect(setWebhookCall).toBeDefined();
    const body = JSON.parse((setWebhookCall![1] as RequestInit).body as string) as { url: string; secret_token: string };
    expect(body.url).toBe("https://app.example.com/api/channels/telegram/webhook");
    expect(body.secret_token).toBe("test-webhook-secret");
  });

  it("surfaces an UpstreamAdapterError-derived message when Telegram's setWebhook call fails", async () => {
    const organization = await organizationRepository.create({ name: `Telegram Action Test Org Fail ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 })),
    );

    const result = await registerTelegramWebhook();
    expect(result.ok).toBe(false);

    const accounts = await channelAccountRepository.listByChannelType(organizationId, "TELEGRAM");
    expect(accounts).toHaveLength(0);
  });
});
