/**
 * `GET`/`POST /api/channels/whatsapp/webhook` — Meta's subscription-verification handshake
 * and inbound messages/status callbacks, per docs/implementation-plan.md §3.5/§5/§6.3 and
 * the Phase 9 task brief.
 *
 * ## Inert when disabled
 * Both handlers 404 immediately when `WHATSAPP_ENABLED=false` (the adapter isn't
 * registered — see `src/server/channels/index.ts`). This is the same "disabled -> 404/no-op"
 * choice the Telegram webhook route already made (see its doc comment) — either 404ing the
 * whole route or "respond but always 403 since there's no valid verify token configured"
 * would equally satisfy "the surface is inert" per the task brief; 404 was chosen for
 * consistency with the other channel routes in this codebase (one documented convention,
 * not two).
 *
 * ## GET — the verification handshake
 * Meta calls this once when you register (or re-verify) the webhook URL in the App
 * dashboard, with `?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` query params.
 * If `hub.mode === "subscribe"` and `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`
 * (constant-time compare), the raw `hub.challenge` value is echoed back as plain text with
 * `200` — otherwise `403`.
 *
 * ## POST — inbound messages + delivery-status callbacks
 * 1. Validate: `adapter.validateWebhook(req)` — `X-Hub-Signature-256` HMAC-SHA256 of the RAW
 *    body via `WHATSAPP_APP_SECRET`. Invalid/missing -> `401`, no DB write.
 * 2. Read the raw body ONCE (`req.text()`) and `JSON.parse` it — `validateWebhook` already
 *    read its own clone of the body for the signature check (see that method's doc comment
 *    for why this order avoids the "parse then re-serialize" bug the task brief warns
 *    about); this is the first and only consumption of the route's own `req` body stream.
 * 3. For each `value` block (`extractWhatsAppValueBlocks` — grouped by `phone_number_id`,
 *    since a deployment could have multiple WhatsApp Business phone numbers each mapped to
 *    its own `ChannelAccount`): resolve the `ChannelAccount` by
 *    `channelAccountRepository.findActiveByChannelTypeAndExternalAccountId`. No match ->
 *    log + skip that block (still `200` overall — a configuration gap is not the sender's
 *    fault, same precedent as the Telegram route's "no_channel_account" case).
 * 4. New messages -> `processInboundMessage` (Phase 5) — idempotent on
 *    `(channelAccountId, externalMessageId)`, so a replayed webhook (Meta retries
 *    aggressively) short-circuits to the existing `Message` row.
 * 5. Status callbacks (`sent`/`delivered`/`read`/`failed`) -> a DISTINCT branch,
 *    `applyDeliveryStatusUpdate` (`../../../../server/messaging/deliveryStatusService.ts`) —
 *    see that module's doc comment for why status callbacks are handled separately from
 *    `processInboundMessage` rather than folded into it.
 *
 * Always returns `200` once past signature validation (even on "ignored" cases), so Meta
 * doesn't retry-storm something we've deliberately decided not to process further.
 */
import { timingSafeEqual } from "node:crypto";
import { channelAdapterRegistry } from "@/server/channels";
import type { WhatsAppAdapter } from "@/server/channels/whatsapp/adapter";
import { extractWhatsAppValueBlocks, mapWhatsAppStatus, type WhatsAppWebhookPayload } from "@/server/channels/whatsapp/parse";
import { env } from "@/server/env";
import { handleRouteError, ValidationError } from "@/server/errors";
import { withContext } from "@/server/logger";
import { applyDeliveryStatusUpdate } from "@/server/messaging/deliveryStatusService";
import { processInboundMessage } from "@/server/messaging/inboundService";
import { channelAccountRepository } from "@/server/repositories/channelAccountRepository";

/** Local constant-time compare — same pattern as `WhatsAppAdapter`/`TelegramAdapter`/`androidAuth.ts` (one small self-contained copy per file, not a premature shared abstraction). */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function GET(req: Request): Promise<Response> {
  if (!channelAdapterRegistry.get("WHATSAPP")) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const verifyToken = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  if (mode === "subscribe" && verifyToken && env.WHATSAPP_VERIFY_TOKEN && constantTimeEquals(verifyToken, env.WHATSAPP_VERIFY_TOKEN)) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  withContext({}).warn({ mode }, "whatsapp_webhook_verify_handshake_rejected");
  return new Response("Forbidden", { status: 403 });
}

export async function POST(req: Request): Promise<Response> {
  const adapter = channelAdapterRegistry.get("WHATSAPP") as WhatsAppAdapter | undefined;
  if (!adapter) {
    return Response.json({ error: "WhatsApp channel is not enabled." }, { status: 404 });
  }

  const isValid = await adapter.validateWebhook(req);
  if (!isValid) {
    withContext({}).warn("WhatsApp webhook: invalid or missing X-Hub-Signature-256 header");
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: WhatsAppWebhookPayload;
  try {
    const rawBody = await req.text();
    payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  } catch {
    return handleRouteError(new ValidationError("Malformed WhatsApp webhook payload."));
  }

  try {
    const blocks = extractWhatsAppValueBlocks(payload);

    for (const block of blocks) {
      const channelAccount = await channelAccountRepository.findActiveByChannelTypeAndExternalAccountId("WHATSAPP", block.phoneNumberId);
      if (!channelAccount) {
        // Configuration gap (WhatsApp enabled but no ChannelAccount connected for this
        // phone_number_id yet) — not the sender's fault, so still 200 overall, but logged.
        withContext({}).error({ phoneNumberId: block.phoneNumberId }, "whatsapp_webhook_no_channel_account");
        continue;
      }

      const log = withContext({ organizationId: channelAccount.organizationId, channelAccountId: channelAccount.id });

      for (const message of block.messages) {
        const result = await processInboundMessage(message, channelAccount);
        if (result.wasDuplicate) {
          log.info({ externalMessageId: message.externalMessageId }, "duplicate_webhook_ignored");
        }
      }

      for (const status of block.statuses) {
        const mapped = mapWhatsAppStatus(status);
        const result = await applyDeliveryStatusUpdate(
          channelAccount.organizationId,
          {
            externalMessageId: mapped.externalMessageId,
            status: mapped.status,
            failureReason: mapped.failureReason,
            occurredAt: mapped.occurredAt,
          },
          mapped.externalEventId,
        );
        if (result.ignoredReason === "duplicate") {
          log.info({ externalMessageId: mapped.externalMessageId }, "duplicate_status_callback_ignored");
        } else if (result.ignoredReason === "message_not_found") {
          log.warn({ externalMessageId: mapped.externalMessageId }, "whatsapp_status_callback_unknown_message");
        }
      }
    }

    return Response.json({ ok: true }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}
