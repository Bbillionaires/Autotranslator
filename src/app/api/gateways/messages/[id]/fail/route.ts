/**
 * `POST /api/gateways/messages/:id/fail` — the device reports it could not send the SMS,
 * per docs/implementation-plan.md §3.6/§5 and the Phase 8 task brief.
 *
 * Device-token authenticated. `:id` is the `Message.id` returned by
 * `GET /api/gateways/messages/pending`. Delegates to
 * `src/server/gateways/messageLifecycle.ts`'s `failMessage`, which reuses
 * `outboundService.handleSendFailure` so transient-vs-permanent classification and retry
 * scheduling are identical to any other adapter's failure path.
 */
import { authenticateDevice } from "@/server/gateways/androidAuth";
import { failMessage } from "@/server/gateways/messageLifecycle";
import { handleRouteError, ValidationError } from "@/server/errors";
import { gatewayDeviceRateLimiter, rateLimitedResponse } from "@/server/rateLimit";
import { failMessageSchema } from "@/server/validation/androidGateway";

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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return handleRouteError(new ValidationError("Malformed JSON body."));
  }

  const parsed = failMessageSchema.safeParse(body);
  if (!parsed.success) {
    return handleRouteError(new ValidationError("Invalid fail payload.", parsed.error.flatten()));
  }

  try {
    const result = await failMessage(channelAccount, id, parsed.data.reason);
    return Response.json({ ok: true, status: result.message.status, outcome: result.outcome }, { status: 200 });
  } catch (error) {
    return handleRouteError(error, { channelAccountId: channelAccount.id, messageId: id });
  }
}
