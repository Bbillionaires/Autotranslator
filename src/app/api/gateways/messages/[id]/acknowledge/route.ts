/**
 * `POST /api/gateways/messages/:id/acknowledge` — the device confirms it sent the SMS, per
 * docs/implementation-plan.md §3.6/§5 and the Phase 8 task brief.
 *
 * Device-token authenticated. `:id` is the `Message.id` returned by
 * `GET /api/gateways/messages/pending` (NOT the adapter's placeholder `externalMessageId` —
 * see `AndroidSmsAdapter`'s module doc comment). Delegates to
 * `src/server/gateways/messageLifecycle.ts`'s `acknowledgeMessage` for the actual
 * transition/idempotency/device-isolation logic.
 */
import { authenticateDevice } from "@/server/gateways/androidAuth";
import { acknowledgeMessage } from "@/server/gateways/messageLifecycle";
import { handleRouteError, ValidationError } from "@/server/errors";
import { gatewayDeviceRateLimiter, rateLimitedResponse } from "@/server/rateLimit";
import { acknowledgeMessageSchema } from "@/server/validation/androidGateway";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const channelAccount = await authenticateDevice(req);
  if (!channelAccount) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rateLimit = gatewayDeviceRateLimiter.check(channelAccount.id);
  if (!rateLimit.allowed) {
    return rateLimitedResponse();
  }

  const { id } = await params;

  let body: unknown = {};
  const rawBody = await req.text();
  if (rawBody.trim().length > 0) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return handleRouteError(new ValidationError("Malformed JSON body."));
    }
  }

  const parsed = acknowledgeMessageSchema.safeParse(body);
  if (!parsed.success) {
    return handleRouteError(new ValidationError("Invalid acknowledge payload.", parsed.error.flatten()));
  }

  try {
    const message = await acknowledgeMessage(channelAccount, id, parsed.data.externalMessageId);
    return Response.json({ ok: true, status: message.status }, { status: 200 });
  } catch (error) {
    return handleRouteError(error, { channelAccountId: channelAccount.id, messageId: id });
  }
}
