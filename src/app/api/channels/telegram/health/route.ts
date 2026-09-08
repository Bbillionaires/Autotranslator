/**
 * `GET /api/channels/telegram/health` — per-organization connection health for the caller's
 * own Telegram bot, per docs/implementation-plan.md §5, rewritten for per-organization bot
 * credentials. There is no more single global bot to check — this now resolves the CALLER's
 * own organization's Telegram `ChannelAccount` (from their session) and decrypts/checks ITS
 * credentials, mirroring `getTelegramHealthStatus` (`src/server/actions/telegram.ts`, the
 * Settings UI's actual data source) so both entry points report the same thing.
 */
import { auth } from "@/server/auth";
import { channelAdapterRegistry } from "@/server/channels";
import type { TelegramAdapter } from "@/server/channels/telegram/adapter";
import { env } from "@/server/env";
import { handleRouteError } from "@/server/errors";
import { channelAccountRepository } from "@/server/repositories/channelAccountRepository";
import { requireRole } from "@/server/roles";

export async function GET(): Promise<Response> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    if (!env.TELEGRAM_ENABLED) {
      return Response.json({ enabled: false, healthy: false, detail: "Telegram is not enabled (TELEGRAM_ENABLED=false)." }, { status: 200 });
    }

    const accounts = await channelAccountRepository.listByChannelType(organizationId, "TELEGRAM");
    const channelAccount = accounts[0];
    if (!channelAccount || !channelAccount.encryptedCredentials) {
      return Response.json(
        { enabled: true, healthy: false, detail: "No Telegram bot connected for this organization yet." },
        { status: 200 },
      );
    }

    const adapter = channelAdapterRegistry.get("TELEGRAM") as TelegramAdapter | undefined;
    if (!adapter) {
      return Response.json({ enabled: true, healthy: false, detail: "Telegram adapter is not registered." }, { status: 200 });
    }

    const health = await adapter.checkAccountHealth(channelAccount);
    return Response.json({ enabled: true, ...health }, { status: health.healthy ? 200 : 503 });
  } catch (error) {
    return handleRouteError(error);
  }
}
