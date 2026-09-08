/**
 * Route-handler-level tests for `GET /api/channels/whatsapp/health` — Session+Role
 * (Administrator+) guarded, rewritten for per-organization WhatsApp credentials. Exact same
 * shape as `src/app/api/channels/telegram/health/route.test.ts` — see that file for the
 * precedent this mirrors. `auth()` is mocked; no real Graph API call is ever made.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.WHATSAPP_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY = "67".repeat(32);

vi.mock("@/server/auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("@/server/auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("@/server/db");
const { organizationRepository } = await import("@/server/repositories/organizationRepository");
const { channelAccountRepository } = await import("@/server/repositories/channelAccountRepository");
const { encryptWhatsAppCredentials } = await import("@/server/channels/whatsapp/credentials");
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

describe("GET /api/channels/whatsapp/health", () => {
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

  it("returns healthy:false with a 'no account connected' detail for an org with no WhatsApp ChannelAccount", async () => {
    const organization = await organizationRepository.create({ name: `WhatsApp Health Route Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; healthy: boolean; detail?: string };
    expect(body.enabled).toBe(true);
    expect(body.healthy).toBe(false);
    expect(body.detail).toMatch(/no whatsapp account connected/i);
  });

  it("returns 200 with healthy:true using THIS org's own decrypted credentials", async () => {
    const organization = await organizationRepository.create({ name: `WhatsApp Health Route Org 2 ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    await channelAccountRepository.create(organizationId, {
      channelType: "WHATSAPP",
      displayName: "Org WhatsApp",
      externalAccountId: "1234567890",
      encryptedCredentials: encryptWhatsAppCredentials({
        accessToken: "this-orgs-access-token",
        phoneNumberId: "1234567890",
        businessAccountId: "waba-1",
        appSecret: "app-secret",
        verifyToken: "verify-token",
      }),
      status: "ACTIVE",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer this-orgs-access-token");
        return new Response(JSON.stringify({ display_phone_number: "+1 555 000 1111" }), { status: 200 });
      }),
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; healthy: boolean; detail?: string };
    expect(body).toEqual({ enabled: true, healthy: true, detail: "+1 555 000 1111" });
  });

  it("returns 503 when the Graph API call fails for this org's own credentials", async () => {
    const organization = await organizationRepository.create({ name: `WhatsApp Health Route Org 3 ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    await channelAccountRepository.create(organizationId, {
      channelType: "WHATSAPP",
      displayName: "Org WhatsApp",
      externalAccountId: "999",
      encryptedCredentials: encryptWhatsAppCredentials({
        accessToken: "revoked-token",
        phoneNumberId: "999",
        businessAccountId: "waba-2",
        appSecret: "app-secret",
        verifyToken: "verify-token",
      }),
      status: "ACTIVE",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid token" } }), { status: 401 })),
    );

    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { healthy: boolean; detail?: string };
    expect(body.healthy).toBe(false);
    expect(body.detail).toBe("invalid token");
  });
});
