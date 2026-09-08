/**
 * `GET /api/channels/whatsapp/health` — per-organization connection health for the caller's
 * own WhatsApp account, per docs/implementation-plan.md §5. Exact same shape as
 * `src/app/api/channels/telegram/health/route.ts` — see that file for the precedent this
 * mirrors, rewritten for per-organization WhatsApp credentials.
 */
import { auth } from "@/server/auth";
import { channelAdapterRegistry } from "@/server/channels";
import type { WhatsAppAdapter } from "@/server/channels/whatsapp/adapter";
import { env } from "@/server/env";
import { handleRouteError } from "@/server/errors";
import { channelAccountRepository } from "@/server/repositories/channelAccountRepository";
import { requireRole } from "@/server/roles";

export async function GET(): Promise<Response> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    if (!env.WHATSAPP_ENABLED) {
      return Response.json({ enabled: false, healthy: false, detail: "WhatsApp is not enabled (WHATSAPP_ENABLED=false)." }, { status: 200 });
    }

    const accounts = await channelAccountRepository.listByChannelType(organizationId, "WHATSAPP");
    const channelAccount = accounts[0];
    if (!channelAccount || !channelAccount.encryptedCredentials) {
      return Response.json(
        { enabled: true, healthy: false, detail: "No WhatsApp account connected for this organization yet." },
        { status: 200 },
      );
    }

    const adapter = channelAdapterRegistry.get("WHATSAPP") as WhatsAppAdapter | undefined;
    if (!adapter) {
      return Response.json({ enabled: true, healthy: false, detail: "WhatsApp adapter is not registered." }, { status: 200 });
    }

    const health = await adapter.checkAccountHealth(channelAccount);
    return Response.json({ enabled: true, ...health }, { status: health.healthy ? 200 : 503 });
  } catch (error) {
    return handleRouteError(error);
  }
}
