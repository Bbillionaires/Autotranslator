/**
 * `GET /api/gateways/messages/pending` — the device polls for outbound SMS to send, per
 * docs/implementation-plan.md §3.2/§5 and the Phase 8 task brief.
 *
 * Device-token authenticated. Returns only `QUEUED` messages belonging to conversations
 * under THIS device's own `ChannelAccount` — never another org's, never another device's
 * within the same org (`messageRepository.listQueuedForChannelAccount`). Oldest-first, page
 * size capped at 100 (query-param override via `?limit=`, itself clamped by
 * `listPendingQuerySchema`). This is deliberately the entire "offline queueing" story: a
 * message queued while the device has no recent heartbeat just accumulates as `QUEUED` rows
 * and is returned the next time this endpoint is polled — no separate "offline" state
 * exists or is needed (see the Phase 8 task brief's deliverable #5, and this route's test
 * file for the scripted proof).
 */
import { authenticateDevice } from "@/server/gateways/androidAuth";
import { listPendingMessagesForDevice } from "@/server/gateways/messageLifecycle";
import { handleRouteError, ValidationError } from "@/server/errors";
import { gatewayDeviceRateLimiter, rateLimitedResponse } from "@/server/rateLimit";
import { listPendingQuerySchema } from "@/server/validation/androidGateway";

export async function GET(req: Request): Promise<Response> {
  const channelAccount = await authenticateDevice(req);
  if (!channelAccount) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rateLimit = gatewayDeviceRateLimiter.check(channelAccount.id);
  if (!rateLimit.allowed) {
    return rateLimitedResponse();
  }

  const url = new URL(req.url);
  const parsed = listPendingQuerySchema.safeParse({ limit: url.searchParams.get("limit") ?? undefined });
  if (!parsed.success) {
    return handleRouteError(new ValidationError("Invalid query parameters.", parsed.error.flatten()));
  }

  try {
    const messages = await listPendingMessagesForDevice(channelAccount, parsed.data.limit);
    return Response.json({ messages }, { status: 200 });
  } catch (error) {
    return handleRouteError(error, { channelAccountId: channelAccount.id });
  }
}
