/**
 * `GET`/`POST /api/channels/whatsapp/webhook/:channelAccountId` — Meta's subscription-
 * verification handshake and inbound messages/status callbacks, per
 * docs/implementation-plan.md §3.5/§5/§6.3, rewritten for per-organization WhatsApp
 * credentials.
 *
 * This REPLACES the old global `GET`/`POST /api/channels/whatsapp/webhook` route (removed):
 * that route resolved the `ChannelAccount` by peeking inside the body for
 * `value.metadata.phone_number_id` BEFORE knowing which organization's `appSecret` to verify
 * the signature with — workable only because `WHATSAPP_APP_SECRET` was one global env var.
 * The per-account URL sidesteps that problem entirely: the URL itself identifies the
 * account (and therefore its own `appSecret`/`verifyToken`), so there is no "which secret do
 * I check this against?" ambiguity to resolve from the payload at all.
 *
 * ## GET — the verification handshake
 * Meta calls this once when you register (or re-verify) THIS account's webhook URL in the
 * App dashboard, with `?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` query
 * params. If `hub.mode === "subscribe"` and `hub.verify_token` matches THIS account's own
 * stored `verifyToken` (constant-time compare), the raw `hub.challenge` value is echoed back
 * as plain text with `200` — otherwise `403`.
 *
 * ## POST — inbound messages + delivery-status callbacks
 * 1. Resolve the `ChannelAccount` named by the URL's `:channelAccountId` path segment.
 *    Unknown id, wrong channel type, or not `ACTIVE` -> `404`.
 * 2. Decrypt that account's own stored credentials and verify `X-Hub-Signature-256`
 *    (HMAC-SHA256 of the RAW body) against THIS account's own `appSecret` — never a global
 *    one.
 * 3. Read the raw body ONCE (`req.text()`) and `JSON.parse` it.
 * 4. New messages -> `processInboundMessage` (idempotent on
 *    `(channelAccountId, externalMessageId)`).
 * 5. Status callbacks (`sent`/`delivered`/`read`/`failed`) -> `applyDeliveryStatusUpdate`.
 *
 * Always returns `200` once past signature validation (even on "ignored" cases), so Meta
 * doesn't retry-storm something we've deliberately decided not to process further.
 */
import type { ChannelAccount } from "@prisma/client";
import { channelAdapterRegistry } from "@/server/channels";
import { constantTimeEquals } from "@/server/channels/telegram/adapter";
import { extractWhatsAppValueBlocks, mapWhatsAppStatus, type WhatsAppWebhookPayload } from "@/server/channels/whatsapp/parse";
import { verifyWhatsAppSignature } from "@/server/channels/whatsapp/adapter";
import { decryptWhatsAppCredentials } from "@/server/channels/whatsapp/credentials";
import { handleRouteError, ValidationError } from "@/server/errors";
import { withContext } from "@/server/logger";
import { applyDeliveryStatusUpdate } from "@/server/messaging/deliveryStatusService";
import { processInboundMessage } from "@/server/messaging/inboundService";
import { getClientIp, rateLimitedResponse, webhookRateLimiter } from "@/server/rateLimit";
import { channelAccountRepository } from "@/server/repositories/channelAccountRepository";

async function resolveChannelAccount(channelAccountId: string): Promise<ChannelAccount | null> {
  const channelAccount = await channelAccountRepository.findById(channelAccountId);
  if (!channelAccount || channelAccount.channelType !== "WHATSAPP" || channelAccount.status !== "ACTIVE") {
    return null;
  }
  return channelAccount;
}

export async function GET(req: Request, { params }: { params: Promise<{ channelAccountId: string }> }): Promise<Response> {
  if (!channelAdapterRegistry.get("WHATSAPP")) {
    return new Response("Not found", { status: 404 });
  }

  const rateLimit = webhookRateLimiter.check(getClientIp(req));
  if (!rateLimit.allowed) {
    return rateLimitedResponse();
  }

  const { channelAccountId } = await params;
  const channelAccount = await resolveChannelAccount(channelAccountId);
  if (!channelAccount) {
    return new Response("Not found", { status: 404 });
  }

  let verifyToken: string;
  try {
    ({ verifyToken } = decryptWhatsAppCredentials(channelAccount));
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const providedToken = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  if (mode === "subscribe" && providedToken && constantTimeEquals(providedToken, verifyToken)) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  withContext({ organizationId: channelAccount.organizationId, channelAccountId: channelAccount.id }).warn(
    { mode },
    "whatsapp_webhook_verify_handshake_rejected",
  );
  return new Response("Forbidden", { status: 403 });
}

export async function POST(req: Request, { params }: { params: Promise<{ channelAccountId: string }> }): Promise<Response> {
  if (!channelAdapterRegistry.get("WHATSAPP")) {
    return Response.json({ error: "WhatsApp channel is not enabled." }, { status: 404 });
  }

  // Rate-limited per-IP, before any signature validation or DB/OpenAI work — a flood
  // (valid or invalid signature) shouldn't get further than this.
  const rateLimit = webhookRateLimiter.check(getClientIp(req));
  if (!rateLimit.allowed) {
    return rateLimitedResponse();
  }

  const { channelAccountId } = await params;
  const channelAccount = await resolveChannelAccount(channelAccountId);
  if (!channelAccount) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  let appSecret: string;
  try {
    ({ appSecret } = decryptWhatsAppCredentials(channelAccount));
  } catch (error) {
    withContext({ organizationId: channelAccount.organizationId, channelAccountId: channelAccount.id }).error(
      { err: error },
      "whatsapp_webhook_credentials_undecryptable",
    );
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const rawBody = await req.text();
  const signatureHeader = req.headers.get("x-hub-signature-256");
  if (!verifyWhatsAppSignature(signatureHeader, rawBody, appSecret)) {
    withContext({ organizationId: channelAccount.organizationId, channelAccountId: channelAccount.id }).warn(
      "WhatsApp webhook: invalid or missing X-Hub-Signature-256 header",
    );
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  } catch {
    return handleRouteError(new ValidationError("Malformed WhatsApp webhook payload."));
  }

  const log = withContext({ organizationId: channelAccount.organizationId, channelAccountId: channelAccount.id });

  try {
    // This account's own webhook path already tells us which ChannelAccount every block in
    // this payload belongs to — unlike the old global route, there is no need to re-resolve
    // per `phone_number_id`. Still call `extractWhatsAppValueBlocks` (rather than the
    // simpler `normalizeWhatsAppMessages`) since it's the one helper that also surfaces raw
    // `statuses[]` alongside normalized `messages[]`.
    const blocks = extractWhatsAppValueBlocks(payload);

    for (const block of blocks) {
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
