/**
 * Tests for the WhatsApp Server Actions (`connectWhatsAppAccount`, `getWhatsAppHealthStatus`,
 * `getWhatsAppWebhookConfig`), rewritten for per-organization credentials. `../auth`'s
 * `auth()` is mocked; no live Graph API call is ever made — `global.fetch` is mocked
 * throughout. Success paths run against a REAL Postgres test database since they write a
 * `ChannelAccount` row.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.WHATSAPP_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY = "23".repeat(32);
process.env.APP_URL = "https://app.example.com";

vi.mock("../auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("../auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { userRepository } = await import("../repositories/userRepository");
const { registerChannelAdapters } = await import("../channels");
const { decryptWhatsAppCredentials } = await import("../channels/whatsapp/credentials");
const { getWhatsAppHealthStatus, getWhatsAppWebhookConfig, connectWhatsAppAccount } = await import("./whatsapp");

registerChannelAdapters();

function fakeSession(role: Session["user"]["role"], organizationId = "org1", userId = "u1"): Session {
  return { user: { id: userId, organizationId, role }, expires: "" } as Session;
}

const VALID_CREDENTIALS = {
  accessToken: "test-access-token",
  phoneNumberId: "0", // overridden per-test
  businessAccountId: "waba-id",
  appSecret: "test-app-secret",
  verifyToken: "test-verify-token",
};

function stubGraphApiFetch(displayPhoneNumber = "+1 555 000 0000") {
  return vi.fn(async () => new Response(JSON.stringify({ display_phone_number: displayPhoneNumber }), { status: 200 }));
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

describe("getWhatsAppHealthStatus", () => {
  it("rejects a session below Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT"));
    const result = await getWhatsAppHealthStatus();
    expect(result.ok).toBe(false);
  });

  it("reports not-connected for an org with no WhatsApp account yet", async () => {
    const organization = await organizationRepository.create({ name: `WA Health Test Org ${Date.now()}-${Math.random()}` });
    try {
      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organization.id));
      const result = await getWhatsAppHealthStatus();
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

describe("getWhatsAppWebhookConfig", () => {
  it("rejects a session below Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT"));
    const result = await getWhatsAppWebhookConfig();
    expect(result.ok).toBe(false);
  });

  it("returns a null webhookUrl before any account is connected", async () => {
    const organization = await organizationRepository.create({ name: `WA Config Test Org ${Date.now()}-${Math.random()}` });
    try {
      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organization.id));
      const result = await getWhatsAppWebhookConfig();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.connected).toBe(false);
      expect(result.data.webhookUrl).toBeNull();
    } finally {
      await prisma.organization.delete({ where: { id: organization.id } });
    }
  });
});

describe("connectWhatsAppAccount", () => {
  let organizationId: string;

  afterEach(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      organizationId = "";
    }
  });

  it("rejects a session below Administrator", async () => {
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT"));
    const result = await connectWhatsAppAccount({ ...VALID_CREDENTIALS, phoneNumberId: "111" });
    expect(result.ok).toBe(false);
  });

  it("validates credentials via a Graph API health check BEFORE saving, creates a ChannelAccount, and returns the per-account webhook URL", async () => {
    const organization = await organizationRepository.create({ name: `WA Connect Test Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const actingUser = await userRepository.create({
      organizationId,
      name: "Acting Admin",
      email: `wa-admin-${Date.now()}-${Math.random()}@test.dev`,
      role: "ADMINISTRATOR",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, actingUser.id));
    vi.stubGlobal("fetch", stubGraphApiFetch("+1 555 111 2222"));

    const phoneNumberId = `phone-${Date.now()}`;
    const result = await connectWhatsAppAccount({ ...VALID_CREDENTIALS, phoneNumberId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.webhookUrl).toMatch(/\/api\/channels\/whatsapp\/webhook\/.+/);
    expect(result.data.healthDetail).toBe("+1 555 111 2222");

    const accounts = await channelAccountRepository.listByChannelType(organizationId, "WHATSAPP");
    expect(accounts).toHaveLength(1);
    expect(accounts[0].externalAccountId).toBe(phoneNumberId);
    expect(accounts[0].status).toBe("ACTIVE");
    expect(result.data.webhookUrl).toBe(`https://app.example.com/api/channels/whatsapp/webhook/${accounts[0].id}`);

    const decrypted = decryptWhatsAppCredentials(accounts[0]);
    expect(decrypted.accessToken).toBe(VALID_CREDENTIALS.accessToken);
    expect(decrypted.phoneNumberId).toBe(phoneNumberId);

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId, entityType: "ChannelAccount" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("channel_account.connected");
  });

  it("rejects invalid credentials (Graph API health check fails) before creating any ChannelAccount", async () => {
    const organization = await organizationRepository.create({ name: `WA Invalid Creds Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid OAuth access token" } }), { status: 401 })),
    );

    const result = await connectWhatsAppAccount({ ...VALID_CREDENTIALS, phoneNumberId: `bad-${Date.now()}` });
    expect(result.ok).toBe(false);

    const accounts = await channelAccountRepository.listByChannelType(organizationId, "WHATSAPP");
    expect(accounts).toHaveLength(0);
  });

  it("cross-org: two different organizations can each connect their own distinct WhatsApp number", async () => {
    const orgA = await organizationRepository.create({ name: `WA Cross Org A ${Date.now()}-${Math.random()}` });
    const orgB = await organizationRepository.create({ name: `WA Cross Org B ${Date.now()}-${Math.random()}` });

    try {
      const adminA = await userRepository.create({
        organizationId: orgA.id,
        name: "Admin A",
        email: `wa-admin-a-${Date.now()}-${Math.random()}@test.dev`,
        role: "ADMINISTRATOR",
      });
      const adminB = await userRepository.create({
        organizationId: orgB.id,
        name: "Admin B",
        email: `wa-admin-b-${Date.now()}-${Math.random()}@test.dev`,
        role: "ADMINISTRATOR",
      });

      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", orgA.id, adminA.id));
      vi.stubGlobal("fetch", stubGraphApiFetch());
      const phoneA = `phone-a-${Date.now()}`;
      const resultA = await connectWhatsAppAccount({ ...VALID_CREDENTIALS, accessToken: "org-a-token", phoneNumberId: phoneA });
      expect(resultA.ok).toBe(true);

      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", orgB.id, adminB.id));
      vi.stubGlobal("fetch", stubGraphApiFetch());
      const phoneB = `phone-b-${Date.now()}`;
      const resultB = await connectWhatsAppAccount({ ...VALID_CREDENTIALS, accessToken: "org-b-token", phoneNumberId: phoneB });
      expect(resultB.ok).toBe(true);

      if (!resultA.ok || !resultB.ok) return;
      expect(resultA.data.webhookUrl).not.toBe(resultB.data.webhookUrl);

      const orgAAccounts = await channelAccountRepository.listByChannelType(orgA.id, "WHATSAPP");
      const orgBAccounts = await channelAccountRepository.listByChannelType(orgB.id, "WHATSAPP");
      expect(decryptWhatsAppCredentials(orgAAccounts[0]).accessToken).toBe("org-a-token");
      expect(decryptWhatsAppCredentials(orgBAccounts[0]).accessToken).toBe("org-b-token");
    } finally {
      await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    }
  });

  it("rejects a second organization connecting the exact same phoneNumberId another org already has ACTIVE", async () => {
    const orgA = await organizationRepository.create({ name: `WA Same Number Org A ${Date.now()}-${Math.random()}` });
    const orgB = await organizationRepository.create({ name: `WA Same Number Org B ${Date.now()}-${Math.random()}` });
    const sharedPhoneNumberId = `shared-phone-${Date.now()}`;

    try {
      const adminA = await userRepository.create({
        organizationId: orgA.id,
        name: "Admin A",
        email: `wa-shared-admin-a-${Date.now()}-${Math.random()}@test.dev`,
        role: "ADMINISTRATOR",
      });
      const adminB = await userRepository.create({
        organizationId: orgB.id,
        name: "Admin B",
        email: `wa-shared-admin-b-${Date.now()}-${Math.random()}@test.dev`,
        role: "ADMINISTRATOR",
      });

      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", orgA.id, adminA.id));
      vi.stubGlobal("fetch", stubGraphApiFetch());
      const first = await connectWhatsAppAccount({ ...VALID_CREDENTIALS, phoneNumberId: sharedPhoneNumberId });
      expect(first.ok).toBe(true);

      vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", orgB.id, adminB.id));
      vi.stubGlobal("fetch", stubGraphApiFetch());
      const second = await connectWhatsAppAccount({ ...VALID_CREDENTIALS, phoneNumberId: sharedPhoneNumberId });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.message).toMatch(/already connected to another organization/i);
        expect(second.code).toBe("CONFLICT");
      }

      const orgBAccounts = await channelAccountRepository.listByChannelType(orgB.id, "WHATSAPP");
      expect(orgBAccounts).toHaveLength(0);
    } finally {
      await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    }
  });
});

describe("getWhatsAppHealthStatus/getWhatsAppWebhookConfig — WHATSAPP_ENABLED=false", () => {
  it("getWhatsAppHealthStatus reports enabled:false when WHATSAPP_ENABLED is false", async () => {
    vi.resetModules();
    const originalEnabled = process.env.WHATSAPP_ENABLED;
    process.env.WHATSAPP_ENABLED = "false";
    vi.doMock("../auth", () => ({ auth: vi.fn(async () => fakeSession("ADMINISTRATOR")) }));

    const { getWhatsAppHealthStatus: freshGetHealth } = await import("./whatsapp");
    const result = await freshGetHealth();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.healthy).toBe(false);
    }

    vi.doUnmock("../auth");
    if (originalEnabled) process.env.WHATSAPP_ENABLED = originalEnabled;
    vi.resetModules();
  });
});
