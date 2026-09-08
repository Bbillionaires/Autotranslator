/**
 * Integration tests for device authentication (`androidAuth.ts`), run against a REAL
 * Postgres test database — same pattern as Phase 5/6/7's integration tests (see
 * src/server/messaging/__tests__/testDb.ts). Covers the Phase 8 task brief's required
 * cases: token issuance never persists the raw token, valid token accepted, revoked token
 * rejected, tampered/wrong token rejected.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.ANDROID_GATEWAY_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY ??= "fe".repeat(32);
process.env.ANDROID_GATEWAY_SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { authenticateDevice, hashDeviceToken, issueDeviceToken, verifyTokenSignature } = await import("./androidAuth");

let organizationId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

async function registerDevice() {
  const organization = await organizationRepository.create({ name: `Android Auth Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "ANDROID_SMS",
    displayName: "Test device",
    externalAccountId: `+1555${Math.floor(Math.random() * 10_000_000)}`,
    status: "ACTIVE",
  });
  const token = issueDeviceToken(channelAccount.id);
  await channelAccountRepository.setDeviceTokenHash(organizationId, channelAccount.id, hashDeviceToken(token));
  return { channelAccount, token };
}

function buildRequest(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request("https://example.com/api/gateways/heartbeat", { method: "POST", headers });
}

describe("issueDeviceToken / hashDeviceToken", () => {
  it("issues a deterministic, verifiable signature over the deviceId", () => {
    const token = issueDeviceToken("device-abc");
    expect(verifyTokenSignature(token)).toBe("device-abc");
  });

  it("hashing is one-way in practice: the persisted value is never the raw token", async () => {
    const { channelAccount, token } = await registerDevice();
    const persisted = await prisma.channelAccount.findUniqueOrThrow({ where: { id: channelAccount.id } });

    expect(persisted.deviceTokenHash).not.toBeNull();
    expect(persisted.deviceTokenHash).not.toBe(token);
    expect(persisted.deviceTokenHash).toBe(hashDeviceToken(token));
    // Defense-in-depth assertion: the raw token string never appears anywhere on the row.
    expect(JSON.stringify(persisted)).not.toContain(token);
  });
});

describe("authenticateDevice", () => {
  it("accepts a valid, freshly-issued token", async () => {
    const { channelAccount, token } = await registerDevice();
    const authenticated = await authenticateDevice(buildRequest(token));
    expect(authenticated?.id).toBe(channelAccount.id);
  });

  it("rejects a request with no Authorization header", async () => {
    await registerDevice();
    expect(await authenticateDevice(buildRequest(null))).toBeNull();
  });

  it("rejects a tampered token (signature no longer matches)", async () => {
    const { token } = await registerDevice();
    const tampered = `${token}x`;
    expect(await authenticateDevice(buildRequest(tampered))).toBeNull();
  });

  it("rejects a well-formed but wrong token (valid-looking signature for an unregistered deviceId)", async () => {
    await registerDevice();
    const forged = issueDeviceToken("some-other-device-id-that-was-never-registered");
    expect(await authenticateDevice(buildRequest(forged))).toBeNull();
  });

  it("rejects a token for a device that has been revoked", async () => {
    const { channelAccount, token } = await registerDevice();
    await channelAccountRepository.revokeDevice(organizationId, channelAccount.id);

    expect(await authenticateDevice(buildRequest(token))).toBeNull();
  });

  it("rejects a token whose device row was never issued a token hash (defense-in-depth)", async () => {
    const organization = await organizationRepository.create({ name: `Android Auth No-Hash Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const channelAccount = await channelAccountRepository.create(organizationId, {
      channelType: "ANDROID_SMS",
      displayName: "Never finished registering",
      status: "ACTIVE",
    });
    const token = issueDeviceToken(channelAccount.id); // valid signature, but no hash stored
    expect(await authenticateDevice(buildRequest(token))).toBeNull();
  });
});
