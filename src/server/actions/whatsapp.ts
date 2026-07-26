"use server";

/**
 * WhatsApp Server Actions, per docs/implementation-plan.md §5/Phase 9 task brief deliverable
 * #7 ("Settings UI ... if WHATSAPP_ENABLED is false, show 'Not enabled' ... if somehow
 * enabled, show live health status like Telegram's section does"). Deliberately minimal
 * (task brief: "Keep this small") — unlike Telegram, there is no "register webhook now"
 * action here: registering a WhatsApp webhook URL + verify token happens entirely in the
 * Meta App dashboard (a human, external step — see docs/channel-adapters.md), not something
 * this app can call an API to do on the operator's behalf the way Telegram's `setWebhook` is.
 */
import { auth } from "../auth";
import { channelAdapterRegistry } from "../channels";
import { env } from "../env";
import { toSafeActionError } from "../errors";
import { requireRole } from "../roles";

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

export interface WhatsAppHealthStatus {
  enabled: boolean;
  healthy: boolean;
  detail?: string;
}

export async function getWhatsAppHealthStatus(): Promise<ActionResult<WhatsAppHealthStatus>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");

    const adapter = channelAdapterRegistry.get("WHATSAPP");
    if (!adapter) {
      return {
        ok: true,
        data: { enabled: env.WHATSAPP_ENABLED, healthy: false, detail: "WHATSAPP_ENABLED is false." },
      };
    }
    const health = await adapter.healthCheck();
    return { ok: true, data: { enabled: true, ...health } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
