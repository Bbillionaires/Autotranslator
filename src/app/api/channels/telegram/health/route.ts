/**
 * `GET /api/channels/telegram/health` — connection health for the Telegram adapter, per
 * docs/implementation-plan.md §5 ("Telegram | GET /api/channels/telegram/health |
 * Connection health ... | Session+Role(Administrator+) | calls adapter healthCheck()").
 */
import { auth } from "@/server/auth";
import { channelAdapterRegistry } from "@/server/channels";
import { handleRouteError } from "@/server/errors";
import { requireRole } from "@/server/roles";

export async function GET(): Promise<Response> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");

    const adapter = channelAdapterRegistry.get("TELEGRAM");
    if (!adapter) {
      return Response.json({ enabled: false, healthy: false, detail: "Telegram is not enabled (TELEGRAM_ENABLED=false)." }, { status: 200 });
    }

    const health = await adapter.healthCheck();
    return Response.json({ enabled: true, ...health }, { status: health.healthy ? 200 : 503 });
  } catch (error) {
    return handleRouteError(error);
  }
}
