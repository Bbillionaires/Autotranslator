"use server";

/**
 * Android SMS gateway management Server Actions — H6 + M5 fix (docs/review-report.md).
 *
 * `channelAccountRepository.revokeDevice` was already correct and immediately enforced by
 * `androidAuth.authenticateDevice`, but nothing exposed it: no Server Action, no Route
 * Handler, no UI button. Similarly, device registration only existed as a Route Handler
 * (`POST /api/gateways/register`) with no Settings UI to drive it. This file adds the
 * missing Session+Role-guarded entry points; `android-section.tsx` (Settings UI) is the
 * client-facing consumer.
 */
import { z } from "zod";
import { auth } from "../auth";
import { toSafeActionError } from "../errors";
import { registerAndroidDevice as registerAndroidDeviceInternal } from "../gateways/deviceRegistration";
import { auditLogRepository } from "../repositories/auditLogRepository";
import { channelAccountRepository } from "../repositories/channelAccountRepository";
import { requireRole } from "../roles";
import { registerDeviceSchema } from "../validation/androidGateway";

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

/** A minimal, per-device health summary — mirrors `AndroidSmsAdapter.getDeviceHealth`'s shape without a hard dependency on the adapter being registered (ANDROID_GATEWAY_ENABLED could be off while devices still exist historically). */
function deviceHealth(device: { revokedAt: Date | null; lastHeartbeatAt: Date | null }): { healthy: boolean; detail: string } {
  if (device.revokedAt) {
    return { healthy: false, detail: "Device is revoked." };
  }
  if (!device.lastHeartbeatAt) {
    return { healthy: false, detail: "Device has never sent a heartbeat." };
  }
  const staleMs = Date.now() - device.lastHeartbeatAt.getTime();
  const HEARTBEAT_STALE_AFTER_MS = 5 * 60 * 1000; // matches AndroidSmsAdapter's threshold
  return {
    healthy: staleMs <= HEARTBEAT_STALE_AFTER_MS,
    detail: `Last heartbeat ${Math.round(staleMs / 1000)}s ago.`,
  };
}

export interface AndroidDeviceView {
  id: string;
  displayName: string;
  phoneNumber: string | null;
  status: string;
  lastHeartbeatAt: string | null;
  revokedAt: string | null;
  healthy: boolean;
  healthDetail: string;
}

/** Server Action `listAndroidDevices` — Session+Role(Administrator+): backs the Android SMS Settings section's device list. */
export async function listAndroidDevices(): Promise<ActionResult<AndroidDeviceView[]>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const devices = await channelAccountRepository.listByChannelType(organizationId, "ANDROID_SMS");
    const views: AndroidDeviceView[] = devices.map((device) => {
      const health = deviceHealth(device);
      return {
        id: device.id,
        displayName: device.displayName,
        phoneNumber: device.externalAccountId,
        status: device.status,
        lastHeartbeatAt: device.lastHeartbeatAt ? device.lastHeartbeatAt.toISOString() : null,
        revokedAt: device.revokedAt ? device.revokedAt.toISOString() : null,
        healthy: health.healthy,
        healthDetail: health.detail,
      };
    });

    return { ok: true, data: views };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

export interface RegisterAndroidDeviceResult {
  deviceId: string;
  deviceToken: string;
}

/**
 * Server Action `registerAndroidDevice` — Session+Role(Administrator+), audit-logged (M1).
 * Mirrors `POST /api/gateways/register`'s behavior exactly (both call the same
 * `registerAndroidDevice` helper in `src/server/gateways/deviceRegistration.ts`) — this is
 * the Settings-UI-facing entry point, the Route Handler remains for scripted/API callers.
 */
export async function registerAndroidDevice(
  input: z.infer<typeof registerDeviceSchema>,
): Promise<ActionResult<RegisterAndroidDeviceResult>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const parsed = registerDeviceSchema.parse(input);
    const result = await registerAndroidDeviceInternal(organizationId, parsed);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "channel_account.connected",
      entityType: "ChannelAccount",
      entityId: result.deviceId,
      metadata: { channelType: "ANDROID_SMS", displayName: parsed.deviceName },
    });

    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const revokeAndroidDeviceSchema = z.object({ deviceId: z.string().min(1) });

/**
 * Server Action `revokeAndroidDevice` — H6 fix. Session+Role(Administrator+), audit-logged.
 * Wraps the already-correct `channelAccountRepository.revokeDevice`, which
 * `androidAuth.authenticateDevice` checks on every subsequent gateway request — revocation
 * takes effect immediately, with no need to rotate `ANDROID_GATEWAY_SIGNING_SECRET`.
 */
export async function revokeAndroidDevice(
  input: z.infer<typeof revokeAndroidDeviceSchema>,
): Promise<ActionResult<{ revoked: true }>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const parsed = revokeAndroidDeviceSchema.parse(input);
    await channelAccountRepository.revokeDevice(organizationId, parsed.deviceId);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "channel_account.device_revoked",
      entityType: "ChannelAccount",
      entityId: parsed.deviceId,
    });

    return { ok: true, data: { revoked: true } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
