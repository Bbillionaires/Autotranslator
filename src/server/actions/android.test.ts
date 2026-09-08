/**
 * Tests for the Android SMS gateway management Server Actions (H6 + M5 fix,
 * docs/review-report.md): `listAndroidDevices`, `registerAndroidDevice`,
 * `revokeAndroidDevice`. Runs against a REAL Postgres test database (see
 * ../messaging/__tests__/testDb.ts) since `revokeAndroidDevice`'s whole point is proven by
 * an end-to-end check against the real gateway auth path (register -> revoke -> any gateway
 * call -> 401).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.ANDROID_GATEWAY_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY ??= "fe".repeat(32);
process.env.ANDROID_GATEWAY_SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

vi.mock("../auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("../auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { userRepository } = await import("../repositories/userRepository");
const { listAndroidDevices, registerAndroidDevice, revokeAndroidDevice } = await import("./android");
const { POST: heartbeatPOST } = await import("@/app/api/gateways/heartbeat/route");

function fakeSession(role: Session["user"]["role"], organizationId: string, userId: string): Session {
  return { user: { id: userId, organizationId, role }, expires: "" } as Session;
}

let organizationId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  vi.mocked(auth).mockReset();
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

async function setUpOrgAndAdmin() {
  const organization = await organizationRepository.create({ name: `Android Actions Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const admin = await userRepository.create({
    organizationId,
    name: "Test Admin",
    email: `android-admin-${Date.now()}-${Math.random()}@test.dev`,
    role: "ADMINISTRATOR",
  });
  return { organization, admin };
}

describe("registerAndroidDevice", () => {
  it("rejects a session below Administrator", async () => {
    const { organization } = await setUpOrgAndAdmin();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organization.id, "irrelevant"));

    const result = await registerAndroidDevice({ deviceName: "Phone", phoneNumber: "+15551230000" });
    expect(result.ok).toBe(false);
  });

  it("registers a device, returns a token once, and writes an AuditLog row", async () => {
    const { organization, admin } = await setUpOrgAndAdmin();
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organization.id, admin.id));

    const result = await registerAndroidDevice({ deviceName: "Warehouse phone", phoneNumber: "+15551230001" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.deviceToken).toContain(result.data.deviceId);

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId: organization.id, entityType: "ChannelAccount" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("channel_account.connected");
  });
});

describe("listAndroidDevices", () => {
  it("rejects a session below Administrator", async () => {
    const { organization } = await setUpOrgAndAdmin();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organization.id, "irrelevant"));

    const result = await listAndroidDevices();
    expect(result.ok).toBe(false);
  });

  it("lists a registered device with health info", async () => {
    const { organization, admin } = await setUpOrgAndAdmin();
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organization.id, admin.id));

    await registerAndroidDevice({ deviceName: "Front desk phone", phoneNumber: "+15551230002" });
    const result = await listAndroidDevices();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0].displayName).toBe("Front desk phone");
    expect(result.data[0].healthy).toBe(false); // never heartbeated yet
    expect(result.data[0].healthDetail).toMatch(/never sent a heartbeat/i);
  });
});

describe("revokeAndroidDevice", () => {
  it("rejects a session below Administrator", async () => {
    const { organization } = await setUpOrgAndAdmin();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organization.id, "irrelevant"));

    const result = await revokeAndroidDevice({ deviceId: "does-not-matter" });
    expect(result.ok).toBe(false);
  });

  it("H6: register -> revoke -> any gateway call -> 401, and writes an AuditLog row", async () => {
    const { organization, admin } = await setUpOrgAndAdmin();
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organization.id, admin.id));

    const registerResult = await registerAndroidDevice({ deviceName: "Revoke Test Phone", phoneNumber: "+15551230003" });
    expect(registerResult.ok).toBe(true);
    if (!registerResult.ok) return;
    const { deviceId, deviceToken } = registerResult.data;

    function heartbeatRequest(): Request {
      return new Request("https://example.com/api/gateways/heartbeat", {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceToken}` },
      });
    }

    // Before revocation: the device's token works.
    const beforeRevoke = await heartbeatPOST(heartbeatRequest());
    expect(beforeRevoke.status).toBe(200);

    const revokeResult = await revokeAndroidDevice({ deviceId });
    expect(revokeResult.ok).toBe(true);

    // After revocation: the SAME token is rejected immediately, no signing-secret rotation needed.
    const afterRevoke = await heartbeatPOST(heartbeatRequest());
    expect(afterRevoke.status).toBe(401);

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId: organization.id, action: "channel_account.device_revoked" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].entityId).toBe(deviceId);
  });

  it("revoking an already-revoked device is idempotent, not an error", async () => {
    const { organization, admin } = await setUpOrgAndAdmin();
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organization.id, admin.id));

    const registerResult = await registerAndroidDevice({ deviceName: "Idempotent Revoke Phone", phoneNumber: "+15551230004" });
    expect(registerResult.ok).toBe(true);
    if (!registerResult.ok) return;

    const first = await revokeAndroidDevice({ deviceId: registerResult.data.deviceId });
    expect(first.ok).toBe(true);
    const second = await revokeAndroidDevice({ deviceId: registerResult.data.deviceId });
    expect(second.ok).toBe(true);
  });
});
