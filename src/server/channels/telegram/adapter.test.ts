/**
 * Unit tests for `TelegramAdapter`. No live network call is ever made — `global.fetch` is
 * mocked in every test, per the Phase 6 task brief's "No live network calls to Telegram in
 * tests — mock fetch" working rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NOTE: `../../errors` (and everything else server-side) must be dynamically imported AFTER
// the process.env assignments below, not statically imported above — static imports are
// hoisted and evaluate before any other top-level code in this module, which would import
// `env.ts` (transitively, via `errors.ts` -> `logger.ts` -> `env.ts`) BEFORE
// TELEGRAM_BOT_TOKEN/TELEGRAM_WEBHOOK_SECRET are set, freezing `env.TELEGRAM_BOT_TOKEN` as
// `undefined` for this module graph. Same pattern as the other integration test files'
// `configureTestDatabaseEnv()` + dynamic-import convention.
process.env.TELEGRAM_BOT_TOKEN ??= "test-bot-token";
process.env.TELEGRAM_WEBHOOK_SECRET ??= "test-webhook-secret";

const { UpstreamAdapterError } = await import("../../errors");
const { TelegramAdapter } = await import("./adapter");
const { classifyAdapterFailure } = await import("../../messaging/failureClassifier");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("TelegramAdapter.validateWebhook", () => {
  let adapter: InstanceType<typeof TelegramAdapter>;

  beforeEach(() => {
    adapter = new TelegramAdapter();
  });

  it("accepts a request whose secret-token header matches TELEGRAM_WEBHOOK_SECRET", async () => {
    const req = new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret" },
    });
    expect(await adapter.validateWebhook(req)).toBe(true);
  });

  it("rejects a request with the wrong secret-token header", async () => {
    const req = new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong-secret" },
    });
    expect(await adapter.validateWebhook(req)).toBe(false);
  });

  it("rejects a request with no secret-token header at all", async () => {
    const req = new Request("https://example.com/webhook", { method: "POST" });
    expect(await adapter.validateWebhook(req)).toBe(false);
  });

  it("rejects a header that only differs in length from the configured secret (no early-return timing leak)", async () => {
    const req = new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "short" },
    });
    expect(await adapter.validateWebhook(req)).toBe(false);
  });
});

describe("TelegramAdapter.sendMessage", () => {
  let adapter: InstanceType<typeof TelegramAdapter>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new TelegramAdapter();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns SENT with the Telegram message_id on success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 987 } }));

    const result = await adapter.sendMessage({
      channelAccount: {} as never,
      externalContactId: "555",
      text: "Hello!",
    });

    expect(result).toEqual({ externalMessageId: "987", status: "SENT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottest-bot-token/sendMessage");
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: "555", text: "Hello!" });
  });

  it("includes reply_to_message_id when replyToExternalId is a valid number", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 988 } }));

    await adapter.sendMessage({
      channelAccount: {} as never,
      externalContactId: "555",
      text: "Reply",
      replyToExternalId: "42",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ reply_to_message_id: 42 });
  });

  it("throws UpstreamAdapterError with a permanent classification on a 403 (blocked/invalid recipient)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, 403));

    try {
      await adapter.sendMessage({ channelAccount: {} as never, externalContactId: "555", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAdapterError);
      expect(classifyAdapterFailure(error)).toBe("permanent");
    }
  });

  it("throws UpstreamAdapterError with a transient classification on a 429 (rate limited)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error_code: 429, description: "Too Many Requests" }, 429));

    try {
      await adapter.sendMessage({ channelAccount: {} as never, externalContactId: "555", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAdapterError);
      expect(classifyAdapterFailure(error)).toBe("transient");
    }
  });

  it("throws a transient UpstreamAdapterError on a network-level failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    try {
      await adapter.sendMessage({ channelAccount: {} as never, externalContactId: "555", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAdapterError);
      expect(classifyAdapterFailure(error)).toBe("transient");
    }
  });
});

describe("TelegramAdapter.healthCheck", () => {
  let adapter: InstanceType<typeof TelegramAdapter>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new TelegramAdapter();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports healthy with the bot's @username on a successful getMe call", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { id: 111, username: "my_bot", first_name: "My Bot" } }));

    const health = await adapter.healthCheck();
    expect(health).toEqual({ healthy: true, detail: "@my_bot" });
  });

  it("reports unhealthy with a detail message when getMe fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error_code: 401, description: "Unauthorized" }, 401));

    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("Unauthorized");
  });

  it("reports unhealthy on a network-level failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));

    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.detail).toBeTruthy();
  });
});

describe("TelegramAdapter.getDeliveryStatus", () => {
  it("always returns null (Telegram has no polling delivery-status API for this MVP)", async () => {
    const adapter = new TelegramAdapter();
    expect(await adapter.getDeliveryStatus()).toBeNull();
  });
});

describe("TelegramAdapter.parseInboundWebhook", () => {
  it("delegates to normalizeTelegramUpdate", async () => {
    const adapter = new TelegramAdapter();
    const update = {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 42, type: "private" },
        text: "hi",
        date: 1_753_531_200,
      },
    };
    const req = new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });

    const normalized = await adapter.parseInboundWebhook(req);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].externalContactId).toBe("42");
    expect(normalized[0].text).toBe("hi");
  });
});
