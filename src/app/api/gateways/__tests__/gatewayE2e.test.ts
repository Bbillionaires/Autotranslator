/**
 * Scripted end-to-end test for the Android SMS gateway — the Phase 8 task brief's
 * Definition of Done, verbatim:
 *
 *   "A scripted client simulating the Android app can register, heartbeat, poll pending
 *   messages, submit an inbound SMS, and acknowledge/fail an outbound send, all
 *   authenticated by its issued device token; a revoked device's subsequent requests are
 *   rejected."
 *
 * This hits the REAL Route Handlers (not the underlying services directly) against a real
 * Postgres test database, driving the exact HTTP-shaped request/response contract a real
 * Android client would use — the closest thing to an actual device integration test this
 * repo can run without a physical phone.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "@/server/messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.ANDROID_GATEWAY_ENABLED = "true";
process.env.CREDENTIAL_ENCRYPTION_KEY ??= "fe".repeat(32);
process.env.ANDROID_GATEWAY_SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

vi.mock("@/server/auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("@/server/auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("@/server/db");
const { organizationRepository } = await import("@/server/repositories/organizationRepository");
const { userRepository } = await import("@/server/repositories/userRepository");
const { channelAccountRepository } = await import("@/server/repositories/channelAccountRepository");
const { gatewayDeviceRateLimiter, gatewayRegisterRateLimiter } = await import("@/server/rateLimit");

const { POST: registerHandler } = await import("../register/route");
const { POST: heartbeatHandler } = await import("../heartbeat/route");
const { POST: inboundHandler } = await import("../inbound/route");
const { GET: pendingHandler } = await import("../messages/pending/route");
const { POST: acknowledgeHandler } = await import("../messages/[id]/acknowledge/route");
const { POST: failHandler } = await import("../messages/[id]/fail/route");

let organizationId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.mocked(auth).mockReset();
  gatewayDeviceRateLimiter.reset();
  gatewayRegisterRateLimiter.reset();
});

afterEach(async () => {
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

function fakeSession(role: Session["user"]["role"], orgId: string, userId: string): Session {
  return { user: { id: userId, organizationId: orgId, role }, expires: "" } as Session;
}

function jsonRequest(url: string, method: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function authedGet(url: string, token: string): Request {
  return new Request(url, { headers: { authorization: `Bearer ${token}` } });
}

describe("Android SMS gateway — scripted device lifecycle (Phase 8 Definition of Done)", () => {
  it("register -> heartbeat -> poll pending -> inbound SMS -> queue outbound -> ack -> fail -> revoke -> rejected", async () => {
    // --- Setup: an Administrator's session, used only for the /register call. ---
    const organization = await organizationRepository.create({ name: `Gateway E2E Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const admin = await userRepository.create({
      organizationId,
      name: "Admin",
      email: `admin-${Date.now()}@test.dev`,
      role: "ADMINISTRATOR",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, admin.id));

    // 1. REGISTER — the scripted client "installs the app" and registers the device.
    const registerRes = await registerHandler(
      jsonRequest("https://example.com/api/gateways/register", "POST", {
        deviceName: "Front Desk Pixel",
        phoneNumber: "+15551230000",
      }),
    );
    expect(registerRes.status).toBe(201);
    const { deviceId, deviceToken } = (await registerRes.json()) as { deviceId: string; deviceToken: string };
    expect(deviceId).toBeTruthy();
    expect(deviceToken).toBeTruthy();

    // 2. HEARTBEAT — the device checks in for the first time.
    const heartbeatRes = await heartbeatHandler(jsonRequest("https://example.com/api/gateways/heartbeat", "POST", {}, deviceToken));
    expect(heartbeatRes.status).toBe(200);
    const deviceAfterHeartbeat = await channelAccountRepository.findByIdInOrgOrThrow(organizationId, deviceId);
    expect(deviceAfterHeartbeat.lastHeartbeatAt).not.toBeNull();

    // 3. POLL PENDING — nothing queued yet.
    const emptyPendingRes = await pendingHandler(authedGet("https://example.com/api/gateways/messages/pending", deviceToken));
    expect(emptyPendingRes.status).toBe(200);
    expect(((await emptyPendingRes.json()) as { messages: unknown[] }).messages).toHaveLength(0);

    // 4. INBOUND SMS — the device relays a text message it received.
    const inboundRes = await inboundHandler(
      jsonRequest(
        "https://example.com/api/gateways/inbound",
        "POST",
        {
          from: "+15559998888",
          text: "Hola, cuando abre la tienda?",
          sentAt: new Date().toISOString(),
          externalMessageId: "device-native-sms-id-1",
        },
        deviceToken,
      ),
    );
    expect(inboundRes.status).toBe(200);
    const { messageId: inboundMessageId } = (await inboundRes.json()) as { messageId: string };
    const inboundMessage = await prisma.message.findUniqueOrThrow({ where: { id: inboundMessageId } });
    expect(inboundMessage.direction).toBe("INBOUND");
    expect(inboundMessage.status).toBe("DELIVERED");

    // 5. STAFF REPLIES — a normal outbound send through the same conversation the inbound
    // SMS just created, using the real AndroidSmsAdapter (registered via
    // registerChannelAdapters, gated on ANDROID_GATEWAY_ENABLED) — proving the adapter's
    // inverted control flow actually queues a Message for device pickup instead of
    // pretending it was sent.
    const { channelAdapterRegistry, registerChannelAdapters } = await import("@/server/channels");
    registerChannelAdapters();
    const adapter = channelAdapterRegistry.getOrThrow("ANDROID_SMS");
    const { sendMessage } = await import("@/server/messaging/outboundService");
    const outboundResult = await sendMessage(
      { organizationId, conversationId: inboundMessage.conversationId, text: "Abrimos a las 9am" },
      { adapter },
    );
    expect(outboundResult.outcome).toBe("QUEUED");
    expect(outboundResult.message.status).toBe("QUEUED");

    // 6. POLL PENDING AGAIN — the queued reply is now waiting for device pickup.
    const pendingRes = await pendingHandler(authedGet("https://example.com/api/gateways/messages/pending", deviceToken));
    const pendingBody = (await pendingRes.json()) as { messages: Array<{ id: string; to: string | null; text: string }> };
    expect(pendingBody.messages).toHaveLength(1);
    expect(pendingBody.messages[0].id).toBe(outboundResult.message.id);
    expect(pendingBody.messages[0].to).toBe("+15559998888");

    // 7. ACKNOWLEDGE — the device confirms SmsManager actually sent it.
    const ackRes = await acknowledgeHandler(
      jsonRequest(
        `https://example.com/api/gateways/messages/${outboundResult.message.id}/acknowledge`,
        "POST",
        { externalMessageId: "android-sms-manager-ref-1" },
        deviceToken,
      ),
      { params: Promise.resolve({ id: outboundResult.message.id }) },
    );
    expect(ackRes.status).toBe(200);
    expect(((await ackRes.json()) as { status: string }).status).toBe("SENT");

    // Pending queue is now empty again — the acknowledged message no longer shows up.
    const pendingAfterAckRes = await pendingHandler(authedGet("https://example.com/api/gateways/messages/pending", deviceToken));
    expect(((await pendingAfterAckRes.json()) as { messages: unknown[] }).messages).toHaveLength(0);

    // 8. A SECOND OUTBOUND MESSAGE, this time the device reports a permanent failure.
    const secondOutbound = await sendMessage(
      { organizationId, conversationId: inboundMessage.conversationId, text: "Second message" },
      { adapter },
    );
    const failRes = await failHandler(
      jsonRequest(
        `https://example.com/api/gateways/messages/${secondOutbound.message.id}/fail`,
        "POST",
        { reason: "INVALID_NUMBER" },
        deviceToken,
      ),
      { params: Promise.resolve({ id: secondOutbound.message.id }) },
    );
    expect(failRes.status).toBe(200);
    expect(((await failRes.json()) as { status: string }).status).toBe("FAILED");

    // 9. REVOKE THE DEVICE (an admin action) — every subsequent device-token request must
    // now be rejected, with no detail beyond a generic 401.
    await channelAccountRepository.revokeDevice(organizationId, deviceId);

    const heartbeatAfterRevoke = await heartbeatHandler(jsonRequest("https://example.com/api/gateways/heartbeat", "POST", {}, deviceToken));
    expect(heartbeatAfterRevoke.status).toBe(401);

    const pendingAfterRevoke = await pendingHandler(authedGet("https://example.com/api/gateways/messages/pending", deviceToken));
    expect(pendingAfterRevoke.status).toBe(401);

    const inboundAfterRevoke = await inboundHandler(
      jsonRequest(
        "https://example.com/api/gateways/inbound",
        "POST",
        { from: "+15550001111", text: "still trying", sentAt: new Date().toISOString(), externalMessageId: "post-revoke-1" },
        deviceToken,
      ),
    );
    expect(inboundAfterRevoke.status).toBe(401);

    const revokedBody = (await pendingAfterRevoke.json()) as Record<string, unknown>;
    expect(revokedBody).toEqual({ error: "unauthorized" });
  });
});
