/**
 * Android gateway device authentication, per docs/implementation-plan.md §6.3/§6.4 and the
 * Phase 8 task brief.
 *
 * Token design (exactly as §6.3 specifies): at `POST /api/gateways/register`, a device
 * token is `${deviceId}.${HMAC-SHA256(deviceId, ANDROID_GATEWAY_SIGNING_SECRET)}` (hex),
 * where `deviceId` is the newly-created `ChannelAccount.id`. This is deterministic (the
 * same deviceId+secret always signs to the same token) — that's what lets §6.3's revocation
 * story work: revoking a device sets `ChannelAccount.revokedAt`, which `authenticateDevice`
 * checks on every request, WITHOUT needing to rotate the shared
 * `ANDROID_GATEWAY_SIGNING_SECRET` (which would break every other device's token too).
 * Security rests on the secret being unknown to attackers: knowing a `deviceId` alone (e.g.
 * because it leaked in a log line) is not enough to forge a valid signature over it.
 *
 * The token is issued once, in the `POST /api/gateways/register` response body, and never
 * again — only `hashDeviceToken(token)` (sha256, hex) is persisted, on
 * `ChannelAccount.deviceTokenHash`. A database leak alone (without the signing secret AND
 * the already-issued plaintext token) never reveals a usable credential.
 *
 * `authenticateDevice(req)` is the single verification entry point every gateway Route
 * Handler calls; it returns the device's `ChannelAccount` on success or `null` on ANY
 * failure (missing header, malformed token, bad signature, unknown device, wrong channel
 * type, revoked, hash mismatch) — deliberately collapsing every failure mode into the same
 * generic outcome so a caller probing for validity can't distinguish *why* a request was
 * rejected (§6.4/§6.8: "safe, generic errors on auth failure"). Route handlers turn a
 * `null` into a bare `401 { error: "unauthorized" }`, matching the precedent
 * `TelegramAdapter.validateWebhook`/the Telegram webhook route already established.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelAccount } from "@prisma/client";
import { env } from "../env";
import { NotConfiguredError } from "../errors";
import { channelAccountRepository } from "../repositories/channelAccountRepository";

function requireSigningSecret(): string {
  if (!env.ANDROID_GATEWAY_SIGNING_SECRET) {
    throw new NotConfiguredError("ANDROID_GATEWAY_SIGNING_SECRET is not configured.");
  }
  return env.ANDROID_GATEWAY_SIGNING_SECRET;
}

function sign(deviceId: string): string {
  return createHmac("sha256", requireSigningSecret()).update(deviceId).digest("hex");
}

/**
 * Constant-time string comparison (same pattern as `TelegramAdapter`'s local
 * `constantTimeEquals` — kept local here rather than shared, matching that precedent of one
 * small self-contained helper per adapter rather than a premature shared abstraction).
 * Falls back to comparing a buffer against itself on length mismatch (still constant-time
 * for that buffer's length) since `timingSafeEqual` requires equal-length inputs and an
 * early `return false` would itself leak the secret's length via timing.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Issues a fresh signed device token for a newly-registered device. Called exactly once, at registration. */
export function issueDeviceToken(deviceId: string): string {
  return `${deviceId}.${sign(deviceId)}`;
}

/** sha256(token), hex-encoded — the only form of the token ever persisted (see module doc comment). */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Verifies the token's HMAC signature and, if valid, returns the `deviceId` it was signed
 * for. Returns `null` on any malformed/invalid input — never throws for a bad token (a
 * `NotConfiguredError` from `requireSigningSecret()` is the one exception, since that's a
 * deployment misconfiguration, not a client error).
 */
export function verifyTokenSignature(token: string): string | null {
  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) return null;

  const deviceId = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expectedSignature = sign(deviceId);
  return constantTimeEquals(signature, expectedSignature) ? deviceId : null;
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Authenticates a gateway Route Handler request end to end:
 *   1. Extract the `Authorization: Bearer <token>` header.
 *   2. Verify its HMAC signature, recovering the claimed `deviceId`.
 *   3. Load that `ChannelAccount` (cross-org — see `channelAccountRepository.findById`'s
 *      doc comment) and check: it exists, it's `ANDROID_SMS`, it isn't revoked, it has a
 *      stored `deviceTokenHash`, and that hash matches this token's hash (the last check
 *      guards against a token that's a *valid HMAC signature* over some other device's id
 *      being replayed against a different row — belt-and-suspenders, since step 2 already
 *      ties the signature to this exact deviceId).
 *
 * Returns the `ChannelAccount` (which carries `organizationId` — every gateway route
 * derives its org-scoping from this, never from client-supplied input) on success, or
 * `null` on ANY failure.
 */
export async function authenticateDevice(req: Request): Promise<ChannelAccount | null> {
  const token = extractBearerToken(req);
  if (!token) return null;

  const deviceId = verifyTokenSignature(token);
  if (!deviceId) return null;

  const channelAccount = await channelAccountRepository.findById(deviceId);
  if (!channelAccount) return null;
  if (channelAccount.channelType !== "ANDROID_SMS") return null;
  if (channelAccount.revokedAt) return null;
  if (!channelAccount.deviceTokenHash) return null;

  const tokenHash = hashDeviceToken(token);
  if (!constantTimeEquals(tokenHash, channelAccount.deviceTokenHash)) return null;

  return channelAccount;
}
