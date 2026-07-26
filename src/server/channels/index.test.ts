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
