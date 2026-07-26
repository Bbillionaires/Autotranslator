/**
 * `POST /api/gateways/heartbeat` — Android gateway device liveness ping, per
 * docs/implementation-plan.md §5/§6.4 and the Phase 8 task brief.
 *
 * Device-token authenticated (NOT session/cookie authenticated — see
 * `src/server/gateways/androidAuth.ts`). Bumps `ChannelAccount.lastHeartbeatAt` (and flips
 * a non-revoked device's status to `ACTIVE`); `AndroidSmsAdapter.getDeviceHealth`/
 * `healthCheck` read this for staleness. Rate-limited per device.
 */
import { authenticateDevice } from "@/server/gateways/androidAuth";
import { handleRouteError } from "@/server/errors";
import { channelAccountRepository } from "@/server/repositories/channelAccountRepository";
import { gatewayDeviceRateLimiter, rateLimitedResponse } from "@/server/rateLimit";

export async function POST(req: Request): Promise<Response> {
  const channelAccount = await authenticateDevice(req);
  if (!channelAccount) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const rateLimit = gatewayDeviceRateLimiter.check(channelAccount.id);
  if (!rateLimit.allowed) {
    return rateLimitedResponse();
  }

  try {
    await channelAccountRepository.touchHeartbeat(channelAccount.organizationId, channelAccount.id);
    return Response.json({ ok: true, serverTime: new Date().toISOString() }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}
