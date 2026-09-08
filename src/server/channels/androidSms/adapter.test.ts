/**
 * Integration tests for `AndroidSmsAdapter`, run against a REAL Postgres test database
 * (`healthCheck`/`getDeviceHealth` read `ChannelAccount.lastHeartbeatAt`/`revokedAt`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureTestDatabaseEnv } from "../../messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.ANDROID_GATEWAY_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY ??= "fe".repeat(32);
process.env.ANDROID_GATEWAY_SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

const { prisma } = await import("../../db");
const { organizationRepository } = await import("../../repositories/organizationRepository");
const { channelAccountRepository } = await import("../../repositories/channelAccountRepository");
const { issueDeviceToken, hashDeviceToken } = await import("../../gateways/androidAuth");
const { AndroidSmsAdapter } = await import("./adapter");

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

async function createDevice(overrides: { lastHeartbeatAt?: Date; revoked?: boolean } = {}) {
  const organization = await organizationRepository.create({ name: `AndroidSmsAdapter Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  let channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "ANDROID_SMS",
    displayName: "Test device",
    externalAccountId: `+1555${Math.floor(Math.random() * 10_000_000)}`,
    status: "ACTIVE",
  });
  if (overrides.lastHeartbeatAt) {
    await prisma.channelAccount.update({ where: { id: channelAccount.id }, data: { lastHeartbeatAt: overrides.lastHeartbeatAt } });
  }
  if (overrides.revoked) {
    channelAccount = await channelAccountRepository.revokeDevice(organizationId, channelAccount.id);
  }
  return prisma.channelAccount.findUniqueOrThrow({ where: { id: channelAccount.id } });
}

describe("AndroidSmsAdapter.sendMessage", () => {
  it("returns QUEUED with no I/O — this is the inverted control flow, not a real send", async () => {
    const adapter = new AndroidSmsAdapter();
    const channelAccount = await createDevice();

    const result = await adapter.sendMessage({
      channelAccount,
      externalContactId: "+15551234567",
      text: "hola",
    });

    expect(result.status).toBe("QUEUED");
    expect(result.externalMessageId).toMatch(/^android-pending-/);
  });

  it("throws a permanent (non-transient) failure when the device has been revoked", async () => {
    const adapter = new AndroidSmsAdapter();
    const channelAccount = await createDevice({ revoked: true });

    await expect(
      adapter.sendMessage({ channelAccount, externalContactId: "+15551234567", text: "hola" }),
    ).rejects.toMatchObject({ detail: { transient: false } });
  });
});

describe("AndroidSmsAdapter.getDeliveryStatus", () => {
  it("always returns null (delivery status comes from device ack/fail calls, not polling)", async () => {
    const adapter = new AndroidSmsAdapter();
    expect(await adapter.getDeliveryStatus()).toBeNull();
  });
});

describe("AndroidSmsAdapter.getDeviceHealth", () => {
  it("reports healthy when the last heartbeat is recent", async () => {
    const adapter = new AndroidSmsAdapter();
    const channelAccount = await createDevice({ lastHeartbeatAt: new Date() });
    const health = await adapter.getDeviceHealth(organizationId, channelAccount.id);
    expect(health.healthy).toBe(true);
  });

  it("reports unhealthy when the last heartbeat is stale", async () => {
    const adapter = new AndroidSmsAdapter();
    const staleHeartbeat = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const channelAccount = await createDevice({ lastHeartbeatAt: staleHeartbeat });
    const health = await adapter.getDeviceHealth(organizationId, channelAccount.id);
    expect(health.healthy).toBe(false);
  });

  it("reports unhealthy when the device has never heartbeated", async () => {
    const adapter = new AndroidSmsAdapter();
    const channelAccount = await createDevice();
    const health = await adapter.getDeviceHealth(organizationId, channelAccount.id);
    expect(health.healthy).toBe(false);
    expect(health.detail).toMatch(/never/i);
  });

  it("reports unhealthy when the device is revoked, even with a recent heartbeat", async () => {
    const adapter = new AndroidSmsAdapter();
    const channelAccount = await createDevice({ lastHeartbeatAt: new Date(), revoked: true });
    const health = await adapter.getDeviceHealth(organizationId, channelAccount.id);
    expect(health.healthy).toBe(false);
    expect(health.detail).toMatch(/revoked/i);
  });
});

describe("AndroidSmsAdapter.validateWebhook / parseInboundWebhook (interface-completeness wrappers)", () => {
  it("validateWebhook delegates to authenticateDevice", async () => {
    const adapter = new AndroidSmsAdapter();
    const channelAccount = await createDevice();
    const token = issueDeviceToken(channelAccount.id);
    await channelAccountRepository.setDeviceTokenHash(organizationId, channelAccount.id, hashDeviceToken(token));

    const validReq = new Request("https://example.com/x", { headers: { authorization: `Bearer ${token}` } });
    expect(await adapter.validateWebhook(validReq)).toBe(true);

    const invalidReq = new Request("https://example.com/x", { headers: { authorization: "Bearer garbage" } });
    expect(await adapter.validateWebhook(invalidReq)).toBe(false);
  });

  it("parseInboundWebhook normalizes a valid JSON body", async () => {
    const adapter = new AndroidSmsAdapter();
    const req = new Request("https://example.com/x", {
      method: "POST",
      body: JSON.stringify({ from: "+15551234567", text: "hi", sentAt: "2026-07-26T12:00:00Z", externalMessageId: "m1" }),
    });
    const normalized = await adapter.parseInboundWebhook(req);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].phoneNumber).toBe("+15551234567");
  });
});
