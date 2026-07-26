/**
 * Boot-time channel adapter registration, per docs/implementation-plan.md §3.2.
 *
 * This is the extension point later phases hook into. Import and call `registerChannelAdapters()`
 * once at app boot (e.g. from a Next.js instrumentation hook).
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
import { AndroidSmsAdapter } from "./androidSms/adapter";
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
 * Phase 9 adds its `if (env.WHATSAPP_ENABLED) channelAdapterRegistry.register(new WhatsAppAdapter())`
 * call here, following the exact same guarded pattern as Telegram/Android below.
 */
export function registerChannelAdapters(): void {
  if (env.TELEGRAM_ENABLED && !channelAdapterRegistry.has("TELEGRAM")) {
    channelAdapterRegistry.register(new TelegramAdapter());
  }
  if (env.ANDROID_GATEWAY_ENABLED && !channelAdapterRegistry.has("ANDROID_SMS")) {
    channelAdapterRegistry.register(new AndroidSmsAdapter());
  }
}
