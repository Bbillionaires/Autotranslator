/**
 * Boot-time channel adapter registration, per docs/implementation-plan.md §3.2.
 *
 * This is the extension point later phases hook into. Import and call `registerChannelAdapters()`
 * once at app boot (e.g. from a Next.js instrumentation hook).
 *
 *   // Phase 8:
 *   import { AndroidSmsAdapter } from "./android";
 *   if (env.ANDROID_GATEWAY_ENABLED) channelAdapterRegistry.register(new AndroidSmsAdapter());
 *
 *   // Phase 9:
 *   import { WhatsAppAdapter } from "./whatsapp";
 *   if (env.WHATSAPP_ENABLED) channelAdapterRegistry.register(new WhatsAppAdapter());
 *
 * The `FakeChannelAdapter` in `./__tests__/fakeAdapter.ts` is NOT registered here — it is
 * test-only and each test wires it directly via `channelAdapterRegistry.registerOverride(...)`
 * or, more commonly, by passing it straight to a service function's `deps.adapter` param
 * instead of going through the registry at all.
 */
import { env } from "../env";
import { channelAdapterRegistry } from "./registry";
import { TelegramAdapter } from "./telegram/adapter";

export { channelAdapterRegistry };
export * from "./types";

/**
 * Registers every real, enabled channel adapter against the shared registry. Safe to call
 * multiple times — each real adapter guards on its own `*_ENABLED` flag and on not already
 * being registered, so a repeated call (e.g. from a hot-reloaded dev server) is a no-op
 * rather than a `ConflictError`.
 *
 * Phase 8/9 add their `if (env.X_ENABLED) channelAdapterRegistry.register(new XAdapter())`
 * calls here, following the exact same guarded pattern as Telegram below.
 */
export function registerChannelAdapters(): void {
  if (env.TELEGRAM_ENABLED && !channelAdapterRegistry.has("TELEGRAM")) {
    channelAdapterRegistry.register(new TelegramAdapter());
  }
}
