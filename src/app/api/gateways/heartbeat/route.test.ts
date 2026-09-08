/**
 * Route-handler-level tests for `POST /api/gateways/heartbeat` — device-token authenticated.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.ANDROID_GATEWAY_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY ??= "fe".repeat(32);
process.env.ANDROID_GATEWAY_SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

const { prisma } = await import("@/server/db");
const { organizationRepository } = await import("@/server/repositories/organizationRepository");
const { channelAccountRepository } = await import("@/server/repositories/channelAccountRepository");
const { issueDeviceToken, hashDeviceToken } = await import("@/server/gateways/androidAuth");
const { gatewayDeviceRateLimiter } = await import("@/server/rateLimit");
const { POST } = await import("./route");

let organizationId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  gatewayDeviceRateLimiter.reset();
});

afterEach(async () => {
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

async function registerDevice() {
  const organization = await organizationRepository.create({ name: `Heartbeat Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "ANDROID_SMS",
    displayName: "Heartbeat device",
    externalAccountId: `+1555hb${Math.floor(Math.random() * 10_000_000)}`,
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

describe("POST /api/gateways/heartbeat — auth", () => {
  it("rejects with 401 when there is no Authorization header", async () => {
    const res = await POST(buildRequest(null));
    expect(res.status).toBe(401);
  });

  it("rejects with 401 for a tampered token", async () => {
    const { token } = await registerDevice();
    const res = await POST(buildRequest(`${token}garbage`));
    expect(res.status).toBe(401);
  });

  it("rejects with 401 once the device has been revoked", async () => {
    const { channelAccount, token } = await registerDevice();
    await channelAccountRepository.revokeDevice(organizationId, channelAccount.id);
    const res = await POST(buildRequest(token));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/gateways/heartbeat — happy path", () => {
  it("updates lastHeartbeatAt and returns 200", async () => {
    const { channelAccount, token } = await registerDevice();
    expect(channelAccount.lastHeartbeatAt).toBeNull();

    const res = await POST(buildRequest(token));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; serverTime: string };
    expect(body.ok).toBe(true);

    const updated = await prisma.channelAccount.findUniqueOrThrow({ where: { id: channelAccount.id } });
    expect(updated.lastHeartbeatAt).not.toBeNull();
  });

  it("is rate-limited beyond the configured per-device window", async () => {
    const { token } = await registerDevice();
    for (let i = 0; i < 60; i += 1) {
      const res = await POST(buildRequest(token));
      expect(res.status).toBe(200);
    }
    const res = await POST(buildRequest(token));
    expect(res.status).toBe(429);
  });
});
