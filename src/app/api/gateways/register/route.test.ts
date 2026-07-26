/**
 * Route-handler-level tests for `POST /api/gateways/register` — Session+Role
 * (Administrator+) guarded (NOT device-token authenticated — the device has no token yet).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.ANDROID_GATEWAY_ENABLED = "true";
process.env.ANDROID_GATEWAY_SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

vi.mock("@/server/auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("@/server/auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("@/server/db");
const { organizationRepository } = await import("@/server/repositories/organizationRepository");
const { userRepository } = await import("@/server/repositories/userRepository");
const { gatewayRegisterRateLimiter } = await import("@/server/rateLimit");
const { POST } = await import("./route");

async function createAdminUser(organizationId: string) {
  return userRepository.create({
    organizationId,
    name: "Test Admin",
    email: `admin-${Date.now()}-${Math.random()}@test.dev`,
    role: "ADMINISTRATOR",
  });
}

function fakeSession(role: Session["user"]["role"], organizationId: string, userId = "u1"): Session {
  return { user: { id: userId, organizationId, role }, expires: "" } as Session;
}

function buildRequest(body: unknown): Request {
  return new Request("https://example.com/api/gateways/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let organizationId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.mocked(auth).mockReset();
  gatewayRegisterRateLimiter.reset();
});

afterEach(async () => {
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

describe("POST /api/gateways/register — authorization", () => {
  it("rejects with 403 when there is no session", async () => {
    vi.mocked(auth).mockResolvedValue(null);
    const res = await POST(buildRequest({ deviceName: "Phone", phoneNumber: "+15551234567" }));
    expect(res.status).toBe(403);
  });

  it("rejects with 403 when the session role is below Administrator", async () => {
    const organization = await organizationRepository.create({ name: `Register Test Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const res = await POST(buildRequest({ deviceName: "Phone", phoneNumber: "+15551234567" }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/gateways/register — happy path", () => {
  it("creates an ACTIVE ANDROID_SMS ChannelAccount and returns a token exactly once", async () => {
    const organization = await organizationRepository.create({ name: `Register Test Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const admin = await createAdminUser(organizationId);
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, admin.id));

    const res = await POST(buildRequest({ deviceName: "Front desk phone", phoneNumber: "+1 (555) 123-9999" }));
    expect(res.status).toBe(201);

    const body = (await res.json()) as { deviceId: string; deviceToken: string };
    expect(body.deviceId).toBeTruthy();
    expect(body.deviceToken).toContain(body.deviceId);

    const channelAccount = await prisma.channelAccount.findUniqueOrThrow({ where: { id: body.deviceId } });
    expect(channelAccount.channelType).toBe("ANDROID_SMS");
    expect(channelAccount.status).toBe("ACTIVE");
    expect(channelAccount.deviceTokenHash).not.toBeNull();
    // The raw token is never persisted anywhere on the row.
    expect(JSON.stringify(channelAccount)).not.toContain(body.deviceToken);

    // M1: device registration (channel account connect) is audit-logged.
    const auditRows = await prisma.auditLog.findMany({ where: { organizationId, entityId: body.deviceId } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("channel_account.connected");
  });

  it("rejects a malformed payload with 400", async () => {
    const organization = await organizationRepository.create({ name: `Register Bad Payload Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const admin = await createAdminUser(organizationId);
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, admin.id));

    const res = await POST(buildRequest({ deviceName: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects re-registering the same phone number in the same org with a conflict", async () => {
    const organization = await organizationRepository.create({ name: `Register Dup Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const admin = await createAdminUser(organizationId);
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, admin.id));

    const first = await POST(buildRequest({ deviceName: "Phone A", phoneNumber: "+15559990000" }));
    expect(first.status).toBe(201);

    const second = await POST(buildRequest({ deviceName: "Phone B", phoneNumber: "+15559990000" }));
    expect(second.status).toBe(409);
  });

  it("supports multiple distinct devices in the same org (no 'the one device' shortcut)", async () => {
    const organization = await organizationRepository.create({ name: `Register Multi Device Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const admin = await createAdminUser(organizationId);
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, admin.id));

    const first = await POST(buildRequest({ deviceName: "Phone A", phoneNumber: "+15551110001" }));
    const second = await POST(buildRequest({ deviceName: "Phone B", phoneNumber: "+15551110002" }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const devices = await prisma.channelAccount.findMany({ where: { organizationId, channelType: "ANDROID_SMS" } });
    expect(devices).toHaveLength(2);
  });
});
