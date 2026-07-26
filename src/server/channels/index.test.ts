/**
 * Tests `registerChannelAdapters()`'s Telegram wiring, per docs/implementation-plan.md §3.2
 * ("built once at boot from parsed env: each adapter is only registered if its *_ENABLED
 * flag ... is true"). Sets TELEGRAM_ENABLED before importing anything (env.ts parses
 * process.env once at import time — see other test files' `configureTestDatabaseEnv`
 * pattern for the same rationale) and uses `vi.resetModules()` between cases so each `it`
 * re-evaluates env.ts/registry.ts against its own process.env snapshot.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
});

describe("registerChannelAdapters — Telegram", () => {
  it("registers TelegramAdapter when TELEGRAM_ENABLED=true", async () => {
    process.env.TELEGRAM_ENABLED = "true";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";

    const { registerChannelAdapters, channelAdapterRegistry } = await import("./index");
    registerChannelAdapters();
    expect(channelAdapterRegistry.has("TELEGRAM")).toBe(true);
  });

  it("does not register TelegramAdapter when TELEGRAM_ENABLED=false", async () => {
    process.env.TELEGRAM_ENABLED = "false";

    const { registerChannelAdapters, channelAdapterRegistry } = await import("./index");
    registerChannelAdapters();
    expect(channelAdapterRegistry.has("TELEGRAM")).toBe(false);
  });

  it("is safe to call twice (no ConflictError on repeated registration)", async () => {
    process.env.TELEGRAM_ENABLED = "true";
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";

    const { registerChannelAdapters } = await import("./index");
    expect(() => {
      registerChannelAdapters();
      registerChannelAdapters();
    }).not.toThrow();
  });
});

/**
 * WhatsApp registration, per the Phase 9 task brief deliverable #6: "Verify (with a test)
 * that with the flag false, channelAdapterRegistry.get('WHATSAPP') returns undefined/not-
 * found" and the inverse when enabled with valid config. Same `vi.resetModules()` +
 * per-test `process.env` pattern as the Telegram block above.
 */
describe("registerChannelAdapters — WhatsApp", () => {
  it("does not register WhatsAppAdapter when WHATSAPP_ENABLED=false (the default)", async () => {
    process.env.WHATSAPP_ENABLED = "false";

    const { registerChannelAdapters, channelAdapterRegistry } = await import("./index");
    registerChannelAdapters();
    expect(channelAdapterRegistry.has("WHATSAPP")).toBe(false);
    expect(channelAdapterRegistry.get("WHATSAPP")).toBeUndefined();
  });

  it("does not register WhatsAppAdapter when WHATSAPP_ENABLED is left entirely unset", async () => {
    delete process.env.WHATSAPP_ENABLED;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    delete process.env.WHATSAPP_APP_SECRET;

    const { registerChannelAdapters, channelAdapterRegistry } = await import("./index");
    registerChannelAdapters();
    expect(channelAdapterRegistry.get("WHATSAPP")).toBeUndefined();
  });

  it("registers WhatsAppAdapter when WHATSAPP_ENABLED=true with valid config", async () => {
    process.env.WHATSAPP_ENABLED = "true";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "waba-id";
    process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
    process.env.WHATSAPP_APP_SECRET = "test-app-secret";

    const { registerChannelAdapters, channelAdapterRegistry } = await import("./index");
    registerChannelAdapters();
    expect(channelAdapterRegistry.has("WHATSAPP")).toBe(true);
    expect(channelAdapterRegistry.get("WHATSAPP")?.channelType).toBe("WHATSAPP");
  });

  it("is safe to call twice (no ConflictError on repeated registration)", async () => {
    process.env.WHATSAPP_ENABLED = "true";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "waba-id";
    process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
    process.env.WHATSAPP_APP_SECRET = "test-app-secret";

    const { registerChannelAdapters } = await import("./index");
    expect(() => {
      registerChannelAdapters();
      registerChannelAdapters();
    }).not.toThrow();
  });
});
