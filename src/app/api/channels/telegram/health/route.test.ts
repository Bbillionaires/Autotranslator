/**
 * Route-handler-level tests for `GET /api/channels/telegram/health` — Session+Role
 * (Administrator+) guarded, rewritten for per-organization bot credentials (this route now
 * looks up the caller's own org's Telegram ChannelAccount, so it needs a real Postgres test
 * database). `auth()` is mocked; no real Telegram API call is ever made — `global.fetch` is
 * mocked where relevant.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.TELEGRAM_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY = "45".repeat(32);

vi.mock("@/server/auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

// See src/server/actions/contacts.test.ts for why `auth` is cast to a single signature here.
const auth = (await import("@/server/auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("@/server/db");
const { organizationRepository } = await import("@/server/repositories/organizationRepository");
const { channelAccountRepository } = await import("@/server/repositories/channelAccountRepository");
const { encryptTelegramCredentials } = await import("@/server/channels/telegram/credentials");
const { registerChannelAdapters } = await import("@/server/channels");
const { GET } = await import("./route");

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

describe("GET /api/channels/telegram/health", () => {
  let organizationId: string;

  afterEach(async () => {
    vi.mocked(auth).mockReset();
    vi.unstubAllGlobals();
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      organizationId = "";
    }
  });

  it("returns a 403 error when the session role is below Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT"));
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns a 403 error when there is no session at all", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns healthy:false with a 'no bot connected' detail for an org with no Telegram ChannelAccount", async () => {
    const organization = await organizationRepository.create({ name: `Telegram Health Route Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; healthy: boolean; detail?: string };
    expect(body.enabled).toBe(true);
    expect(body.healthy).toBe(false);
    expect(body.detail).toMatch(/no telegram bot connected/i);
  });

  it("returns 200 with healthy:true using THIS org's own decrypted bot token", async () => {
    const organization = await organizationRepository.create({ name: `Telegram Health Route Org 2 ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    await channelAccountRepository.create(organizationId, {
      channelType: "TELEGRAM",
      displayName: "Org Bot",
      externalAccountId: "123",
      encryptedCredentials: encryptTelegramCredentials({ botToken: "this-orgs-token", webhookSecret: "secret" }),
      status: "ACTIVE",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("this-orgs-token");
        return new Response(JSON.stringify({ ok: true, result: { id: 123, username: "org_bot", first_name: "Bot" } }), { status: 200 });
      }),
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; healthy: boolean; detail?: string };
    expect(body).toEqual({ enabled: true, healthy: true, detail: "@org_bot" });
  });

  it("returns 503 when getMe fails for this org's own bot token", async () => {
    const organization = await organizationRepository.create({ name: `Telegram Health Route Org 3 ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    await channelAccountRepository.create(organizationId, {
      channelType: "TELEGRAM",
      displayName: "Org Bot",
      externalAccountId: "456",
      encryptedCredentials: encryptTelegramCredentials({ botToken: "revoked-token", webhookSecret: "secret" }),
      status: "ACTIVE",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: "invalid token" }), { status: 401 })),
    );

    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { healthy: boolean; detail?: string };
    expect(body.healthy).toBe(false);
    expect(body.detail).toBe("invalid token");
  });
});
