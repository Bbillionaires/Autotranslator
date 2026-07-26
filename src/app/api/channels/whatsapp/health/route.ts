/**
 * `GET /api/channels/whatsapp/health` — connection health for the WhatsApp adapter, per
 * docs/implementation-plan.md §5 ("WhatsApp | GET /api/channels/whatsapp/health | Connection
 * health | Session+Role(Administrator+) | no-op/'disabled' response if flag off"). Exact
 * same shape as `src/app/api/channels/telegram/health/route.ts` — see that route for the
 * precedent this mirrors.
 */
import { auth } from "@/server/auth";
import { channelAdapterRegistry } from "@/server/channels";
import { handleRouteError } from "@/server/errors";
import { requireRole } from "@/server/roles";

export async function GET(): Promise<Response> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");

    const adapter = channelAdapterRegistry.get("WHATSAPP");
    if (!adapter) {
      return Response.json({ enabled: false, healthy: false, detail: "WhatsApp is not enabled (WHATSAPP_ENABLED=false)." }, { status: 200 });
    }

    const health = await adapter.healthCheck();
    return Response.json({ enabled: true, ...health }, { status: health.healthy ? 200 : 503 });
  } catch (error) {
    return handleRouteError(error);
  }
}
