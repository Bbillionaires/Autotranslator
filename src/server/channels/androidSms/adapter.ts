/**
 * `AndroidSmsAdapter` — the Android SMS gateway channel adapter, per
 * docs/implementation-plan.md §3.2 and the Phase 8 task brief.
 *
 * ## Inverted control flow (read this before touching `sendMessage`)
 *
 * Every other adapter in this codebase (Telegram now, WhatsApp in Phase 9) calls OUT to an
 * external API synchronously inside `sendMessage()` and returns `status: "SENT"` once that
 * call succeeds. `AndroidSmsAdapter` is the opposite: the Android device itself is the
 * channel, and we never call out to it — the device is the one that periodically calls IN
 * to us, via:
 *
 *   1. `GET  /api/gateways/messages/pending`         — the device pulls its queued sends.
 *   2. `POST /api/gateways/messages/:id/acknowledge` — the device pushes a "sent" ack after
 *      actually calling Android's `SmsManager` on-device.
 *   3. `POST /api/gateways/messages/:id/fail`         — the device pushes a failure report.
 *
 * So `sendMessage()` here does **no I/O at all** — no network call, no direct Prisma write.
 * It just returns `{ externalMessageId: <a placeholder pending-ref>, status: "QUEUED" }`.
 * The actual persistence of that `QUEUED` status happens back in
 * `../../messaging/outboundService.ts`'s `confirmAndSend`, which (as of Phase 8) transitions
 * the `Message` row to whatever status THIS function returns, instead of unconditionally to
 * `"SENT"` — see that function's doc comment for the full before/after. The row only
 * reaches `SENT` later, when `POST /api/gateways/messages/:id/acknowledge` calls
 * `acknowledgeMessage()` (`./acknowledgeMessage.ts`), driven by the device's own confirmation
 * that `SmsManager.sendTextMessage` succeeded — never optimistically (§3.6 step 5's
 * invariant holds for Android too, just with an extra hop).
 *
 * `externalMessageId` returned here is NOT the eventual DB `Message.id` (this function
 * receives no `messageId` — `SendMessageInput` doesn't carry one, by the shared interface's
 * design) and is NOT what `/messages/:id/acknowledge`/`/fail` address by (those use the
 * `Message.id` path param, resolved directly from `GET /messages/pending`'s own response,
 * never round-tripped through this field). It's a low-stakes audit placeholder, purely for
 * the `Message.externalMessageId` column and the `queued_for_pickup` `MessageEvent`.
 */
import { randomUUID } from "node:crypto";
import { UpstreamAdapterError } from "../../errors";
import { channelAccountRepository } from "../../repositories/channelAccountRepository";
import type {
  DeliveryStatusUpdate,
  MessagingChannelAdapter,
  NormalizedInboundMessage,
  SendMessageInput,
  SendMessageResult,
} from "../types";
import { inboundSmsSchema } from "../../validation/androidGateway";
import { normalizeAndroidInboundSms } from "./parse";
import { authenticateDevice } from "../../gateways/androidAuth";

/** A device is considered "stale"/unhealthy once its last heartbeat is older than this. */
const HEARTBEAT_STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes

export class AndroidSmsAdapter implements MessagingChannelAdapter {
  readonly channelType = "ANDROID_SMS" as const;

  /**
   * See the module doc comment: deliberately no I/O. Returning `status: "QUEUED"` is what
   * tells `outboundService.confirmAndSend` to persist `QUEUED` (device-pickup-pending)
   * instead of `SENT` on the `Message` row.
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (input.channelAccount.channelType !== "ANDROID_SMS") {
      // Defensive only — the registry/outboundService always resolve the adapter by the
      // conversation's own channelAccount.channelType, so this should be unreachable.
      throw new UpstreamAdapterError("AndroidSmsAdapter invoked for a non-ANDROID_SMS channel account.", {
        transient: false,
      });
    }
    if (input.channelAccount.revokedAt) {
      // Permanent: a revoked device will never poll for/pick up this message. Classified
      // "permanent" (not transient) so this doesn't silently retry forever against a device
      // that's never coming back — a human has to reassign/re-register.
      throw new UpstreamAdapterError("This Android device has been revoked and can no longer send messages.", {
        transient: false,
      });
    }

    return {
      externalMessageId: `android-pending-${randomUUID()}`,
      status: "QUEUED",
    };
  }

  /**
   * Thin wrapper over `authenticateDevice` for interface-contract completeness/unit
   * testing. NOT called by the live `POST /api/gateways/inbound` route, which needs the
   * resolved `ChannelAccount` itself (to pass to `processInboundMessage`) and would
   * otherwise have to authenticate twice (once here, discarding the result, once more to
   * get the account) — that route calls `authenticateDevice` directly instead. See the
   * Phase 8 task brief: "you can implement these as thin wrappers ... or ... have the Route
   * Handler do device-token auth directly ... your call, document it" — this file does
   * both, for different reasons: the wrapper exists so the adapter alone is fully
   * interface-conformant and testable in isolation; the live route bypasses it to avoid a
   * redundant DB round trip.
   */
  async validateWebhook(req: Request): Promise<boolean> {
    return (await authenticateDevice(req)) !== null;
  }

  /**
   * Thin wrapper for interface completeness (see `validateWebhook`'s doc comment for why
   * the live route doesn't call this either — it also needs to read+Zod-validate the body
   * itself, and a `Request`'s body can only be consumed once).
   */
  async parseInboundWebhook(req: Request): Promise<NormalizedInboundMessage[]> {
    const body = await req.json();
    const parsed = inboundSmsSchema.parse(body);
    return [normalizeAndroidInboundSms(parsed)];
  }

  /**
   * Always `null`: delivery status for Android SMS comes exclusively from the device's
   * explicit `POST /api/gateways/messages/:id/acknowledge`/`/fail` calls (handled directly
   * by `../../messaging/outboundService.ts`'s `handleSendFailure` and this module's
   * acknowledge/fail helpers), never from polling an external API — there is no external
   * API to poll. Same "always null" precedent as `TelegramAdapter.getDeliveryStatus`.
   */
  async getDeliveryStatus(): Promise<DeliveryStatusUpdate | null> {
    return null;
  }

  /**
   * Interface-required, parameterless — but this channel can have MANY devices
   * (`ChannelAccount`s) across many orgs, and `MessagingChannelAdapter.healthCheck()` has no
   * per-device parameter to narrow with. Reports an aggregate summary: healthy if at least
   * one ACTIVE, non-revoked Android device anywhere has heartbeated within
   * `HEARTBEAT_STALE_AFTER_MS`; trivially healthy (nothing to report as broken) if zero
   * devices are registered yet. For the actually useful per-device signal, see
   * `getDeviceHealth` below (org-scoped, used by anything that knows which device it cares
   * about — e.g. a future Settings UI device list).
   */
  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    const devices = await channelAccountRepository.listAllActiveByChannelType("ANDROID_SMS");
    if (devices.length === 0) {
      return { healthy: true, detail: "No Android gateway devices registered yet." };
    }

    const threshold = Date.now() - HEARTBEAT_STALE_AFTER_MS;
    const live = devices.filter((device) => device.lastHeartbeatAt && device.lastHeartbeatAt.getTime() >= threshold);

    return {
      healthy: live.length > 0,
      detail: `${live.length}/${devices.length} device(s) heartbeated within the last ${HEARTBEAT_STALE_AFTER_MS / 60_000} minutes.`,
    };
  }

  /**
   * Per-device health, org-scoped. Not part of `MessagingChannelAdapter` — an
   * Android-gateway-specific extra, same precedent as `TelegramAdapter.getBotInfo()`.
   */
  async getDeviceHealth(organizationId: string, channelAccountId: string): Promise<{ healthy: boolean; detail?: string }> {
    const account = await channelAccountRepository.findByIdInOrgOrThrow(organizationId, channelAccountId);
    if (account.revokedAt) {
      return { healthy: false, detail: "Device is revoked." };
    }
    if (!account.lastHeartbeatAt) {
      return { healthy: false, detail: "Device has never sent a heartbeat." };
    }
    const staleMs = Date.now() - account.lastHeartbeatAt.getTime();
    return {
      healthy: staleMs <= HEARTBEAT_STALE_AFTER_MS,
      detail: `Last heartbeat ${Math.round(staleMs / 1000)}s ago.`,
    };
  }
}

export const androidSmsAdapter = new AndroidSmsAdapter();
