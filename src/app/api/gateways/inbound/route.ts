/**
 * `POST /api/gateways/inbound` — the Android device pushes a received SMS, per
 * docs/implementation-plan.md §3.5/§5 and the Phase 8 task brief.
 *
 * Device-token authenticated (not a signature-validated webhook — see
 * `src/server/gateways/androidAuth.ts`'s module doc comment for why this channel's inbound
 * path differs from Telegram/WhatsApp's webhook pattern). This route does the device-token
 * auth AND the normalization itself (rather than calling
 * `AndroidSmsAdapter.validateWebhook`/`parseInboundWebhook`) so it only reads+parses the
 * request body once — see `AndroidSmsAdapter`'s doc comment on those two methods for the
 * full rationale. Delegates to `processInboundMessage` (Phase 5) exactly like the Telegram
 * webhook route does, so dedup (`idempotencyKey`), Contact/Conversation resolution, and
 * translation all go through the identical, already-tested lifecycle. Rate-limited per
 * device.
 */
import { authenticateDevice } from "@/server/gateways/androidAuth";
import { normalizeAndroidInboundSms } from "@/server/channels/androidSms/parse";
import { handleRouteError, ValidationError } from "@/server/errors";
import { withContext } from "@/server/logger";
import { processInboundMessage } from "@/server/messaging/inboundService";
import { gatewayDeviceRateLimiter, rateLimitedResponse } from "@/server/rateLimit";
import { inboundSmsSchema } from "@/server/validation/androidGateway";

export async function POST(req: Request): Promise<Response> {
  const channelAccount = await authenticateDevice(req);
  if (!channelAccount) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rateLimit = gatewayDeviceRateLimiter.check(channelAccount.id);
  if (!rateLimit.allowed) {
    return rateLimitedResponse();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return handleRouteError(new ValidationError("Malformed JSON body."));
  }

  const parsed = inboundSmsSchema.safeParse(body);
  if (!parsed.success) {
    return handleRouteError(new ValidationError("Invalid inbound SMS payload.", parsed.error.flatten()));
  }

  try {
    const normalized = normalizeAndroidInboundSms(parsed.data);
    const result = await processInboundMessage(normalized, channelAccount);

    if (result.wasDuplicate) {
      withContext({ organizationId: channelAccount.organizationId, channelAccountId: channelAccount.id }).info(
        { externalMessageId: normalized.externalMessageId },
        "duplicate_webhook_ignored",
      );
    }

    return Response.json({ ok: true, messageId: result.message.id, duplicate: result.wasDuplicate }, { status: 200 });
  } catch (error) {
    return handleRouteError(error, { channelAccountId: channelAccount.id });
  }
}
