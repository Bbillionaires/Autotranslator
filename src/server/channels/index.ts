/**
 * Boot-time channel adapter registration, per docs/implementation-plan.md §3.2.
 *
 * `registerChannelAdapters()` populates the shared registry with every REAL, enabled
 * adapter: Telegram (`TELEGRAM_ENABLED`), Android SMS gateway (`ANDROID_GATEWAY_ENABLED`),
 * and WhatsApp (`WHATSAPP_ENABLED`) — each guarded on its own flag, defaulting to `false`,
 * so the app boots cleanly and every disabled channel's adapter/routes stay inert with zero
 * of that channel's env vars set (§6.7).
 *
 * It's called once, below, as a side effect of importing this module — every real
 * consumer (webhook routes, Server Actions, the retry worker) already imports
 * `channelAdapterRegistry` from here, so this guarantees registration happens against the
 * exact same singleton instance every consumer resolves adapters from. (An earlier version
 * of this comment suggested calling it from a Next.js `instrumentation.ts` boot hook
 * instead — that doesn't work: `instrumentation.ts` and a route handler get compiled into
 * separate bundles/chunks, each importing its own copy of this module, so registering
 * against the `instrumentation.ts` copy left every route handler's copy of the registry
 * empty. Self-registration on import sidesteps that entirely.)
 *
 * The `FakeChannelAdapter` in `./__tests__/fakeAdapter.ts` is NOT registered here — it is
 * test-only and each test wires it directly via `channelAdapterRegistry.registerOverride(...)`
 * or, more commonly, by passing it straight to a service function's `deps.adapter` param
 * instead of going through the registry at all.
 */
import { env } from "../env";
import { AndroidSmsAdapter } from "./androidSms/adapter";
import { channelAdapterRegistry } from "./registry";
import { TelegramAdapter } from "./telegram/adapter";
import { WhatsAppAdapter } from "./whatsapp/adapter";

export { channelAdapterRegistry };
export * from "./types";

/**
 * Registers every real, enabled channel adapter against the shared registry. Safe to call
 * multiple times — each real adapter guards on its own `*_ENABLED` flag and on not already
 * being registered, so a repeated call (e.g. from a hot-reloaded dev server) is a no-op
 * rather than a `ConflictError`.
 */
export function registerChannelAdapters(): void {
  if (env.TELEGRAM_ENABLED && !channelAdapterRegistry.has("TELEGRAM")) {
    channelAdapterRegistry.register(new TelegramAdapter());
  }
  if (env.ANDROID_GATEWAY_ENABLED && !channelAdapterRegistry.has("ANDROID_SMS")) {
    channelAdapterRegistry.register(new AndroidSmsAdapter());
  }
  // Phase 9: the entire WhatsApp surface is inert with zero WHATSAPP_* env vars set — this
  // is the ONLY place `WhatsAppAdapter` is ever constructed/registered, guarded on the same
  // `*_ENABLED` pattern as every other channel above.
  if (env.WHATSAPP_ENABLED && !channelAdapterRegistry.has("WHATSAPP")) {
    channelAdapterRegistry.register(new WhatsAppAdapter());
  }
}

registerChannelAdapters();
