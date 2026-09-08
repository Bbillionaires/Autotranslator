/**
 * Unit tests for `TelegramAdapter`, rewritten for per-organization bot credentials. No live
 * network call is ever made — `global.fetch` is mocked in every test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NOTE: `../../errors` (and everything else server-side) must be dynamically imported AFTER
// the process.env assignments below, not statically imported above — static imports are
// hoisted and evaluate before any other top-level code in this module, which would import
// `env.ts` (transitively, via `errors.ts` -> `logger.ts` -> `env.ts`) BEFORE
// CREDENTIAL_ENCRYPTION_KEY is set, freezing it as `undefined` for this module graph. Same
// pattern as the other integration test files' `configureTestDatabaseEnv()` + dynamic-import
// convention.
process.env.CREDENTIAL_ENCRYPTION_KEY ??= "ef".repeat(32);

const { UpstreamAdapterError } = await import("../../errors");
const { TelegramAdapter, constantTimeEquals } = await import("./adapter");
const { classifyAdapterFailure } = await import("../../messaging/failureClassifier");
const { encryptTelegramCredentials } = await import("./credentials");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeChannelAccount(botToken: string, webhookSecret = "webhook-secret") {
  return { encryptedCredentials: encryptTelegramCredentials({ botToken, webhookSecret }) } as never;
}

describe("constantTimeEquals", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEquals("secret-value", "secret-value")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(constantTimeEquals("secret-value", "wrong-value!")).toBe(false);
  });

  it("returns false for strings of different lengths (no early-return timing leak)", () => {
    expect(constantTimeEquals("short", "a-much-longer-secret-value")).toBe(false);
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

  it("decrypts the bot token from channelAccount and returns SENT with the Telegram message_id on success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 987 } }));

    const result = await adapter.sendMessage({
      channelAccount: fakeChannelAccount("this-orgs-bot-token"),
      externalContactId: "555",
      text: "Hello!",
    });

    expect(result).toEqual({ externalMessageId: "987", status: "SENT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botthis-orgs-bot-token/sendMessage");
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: "555", text: "Hello!" });
  });

  it("uses a DIFFERENT organization's own bot token when given a different channelAccount — never a shared/global one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 1 } }));
    await adapter.sendMessage({ channelAccount: fakeChannelAccount("org-a-token"), externalContactId: "1", text: "hi" });
    const [urlA] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(urlA).toContain("org-a-token");

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 2 } }));
    await adapter.sendMessage({ channelAccount: fakeChannelAccount("org-b-token"), externalContactId: "1", text: "hi" });
    const [urlB] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(urlB).toContain("org-b-token");
    expect(urlA).not.toBe(urlB);
  });

  it("includes reply_to_message_id when replyToExternalId is a valid number", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 988 } }));

    await adapter.sendMessage({
      channelAccount: fakeChannelAccount("token"),
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
      await adapter.sendMessage({ channelAccount: fakeChannelAccount("token"), externalContactId: "555", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAdapterError);
      expect(classifyAdapterFailure(error)).toBe("permanent");
    }
  });

  it("throws UpstreamAdapterError with a transient classification on a 429 (rate limited)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error_code: 429, description: "Too Many Requests" }, 429));

    try {
      await adapter.sendMessage({ channelAccount: fakeChannelAccount("token"), externalContactId: "555", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAdapterError);
      expect(classifyAdapterFailure(error)).toBe("transient");
    }
  });

  it("throws a transient UpstreamAdapterError on a network-level failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    try {
      await adapter.sendMessage({ channelAccount: fakeChannelAccount("token"), externalContactId: "555", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAdapterError);
      expect(classifyAdapterFailure(error)).toBe("transient");
    }
  });
});

describe("TelegramAdapter.getBotInfo", () => {
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

  it("resolves the bot's id/username given an explicit token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { id: 111, username: "my_bot", first_name: "My Bot" } }));

    const info = await adapter.getBotInfo("some-token");
    expect(info).toEqual({ id: 111, username: "my_bot", firstName: "My Bot" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botsome-token/getMe");
  });

  it("returns null when getMe fails (invalid token)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error_code: 401, description: "Unauthorized" }, 401));
    const info = await adapter.getBotInfo("bogus-token");
    expect(info).toBeNull();
  });
});

describe("TelegramAdapter.checkAccountHealth", () => {
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

  it("reports healthy with the bot's @username on a successful getMe call using THIS account's own token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, result: { id: 111, username: "my_bot", first_name: "My Bot" } }));

    const health = await adapter.checkAccountHealth(fakeChannelAccount("this-accounts-token"));
    expect(health).toEqual({ healthy: true, detail: "@my_bot" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("this-accounts-token");
  });

  it("reports unhealthy with a detail message when getMe fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error_code: 401, description: "Unauthorized" }, 401));

    const health = await adapter.checkAccountHealth(fakeChannelAccount("token"));
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("Unauthorized");
  });

  it("reports unhealthy (without throwing) when the account has no stored credentials", async () => {
    const health = await adapter.checkAccountHealth({ encryptedCredentials: null } as never);
    expect(health.healthy).toBe(false);
  });
});

describe("TelegramAdapter.healthCheck (parameterless, interface-required)", () => {
  it("reports the adapter as registered, without needing any per-org credential", async () => {
    const adapter = new TelegramAdapter();
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(true);
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
