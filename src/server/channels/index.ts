/**
 * Boot-time channel adapter registration, per docs/implementation-plan.md §3.2.
 *
 * This is the extension point later phases hook into. Import and call `registerChannelAdapters()`
 * once at app boot (e.g. from a Next.js instrumentation hook) once a real adapter exists.
 * Phase 5 only wires the mechanism — no real adapter is implemented yet, so this function
 * is intentionally a no-op today:
 *
 *   // Phase 6:
 *   import { env } from "../env";
 *   import { TelegramAdapter } from "./telegram";
 *   if (env.TELEGRAM_ENABLED) channelAdapterRegistry.register(new TelegramAdapter());
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
import { channelAdapterRegistry } from "./registry";

export { channelAdapterRegistry };
export * from "./types";

/**
 * Registers every real, enabled channel adapter against the shared registry. Safe to call
 * multiple times (later phases' adapters guard on their own `*_ENABLED` flag); currently a
 * no-op since no real adapter has landed yet.
 */
export function registerChannelAdapters(): void {
  // Phase 6/8/9 add their `if (env.X_ENABLED) channelAdapterRegistry.register(new XAdapter())`
  // calls here.
}
