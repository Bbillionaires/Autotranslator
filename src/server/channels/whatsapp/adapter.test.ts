/**
 * Unit tests for `WhatsAppAdapter`. No live network call is ever made — `global.fetch` is
 * mocked in every test, per the Phase 9 task brief's "No live network calls to Meta's Graph
 * API anywhere in tests — mock fetch" working rule.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NOTE: env-dependent modules must be dynamically imported AFTER the process.env
// assignments below — same rationale as telegram/adapter.test.ts's top-of-file comment
// (static imports are hoisted and would freeze `env.WHATSAPP_*` as undefined).
process.env.WHATSAPP_ENABLED ??= "true";
process.env.WHATSAPP_ACCESS_TOKEN ??= "test-access-token";
process.env.WHATSAPP_PHONE_NUMBER_ID ??= "1234567890";
process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ??= "waba-test-id";
process.env.WHATSAPP_VERIFY_TOKEN ??= "test-verify-token";
process.env.WHATSAPP_APP_SECRET ??= "test-app-secret";

const { UpstreamAdapterError } = await import("../../errors");
const { WhatsAppAdapter } = await import("./adapter");
const { classifyAdapterFailure } = await import("../../messaging/failureClassifier");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function signedRequest(body: unknown, secret = "test-app-secret"): Request {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return new Request("https://example.com/api/channels/whatsapp/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
    body: raw,
  });
}

describe("WhatsAppAdapter.validateWebhook", () => {
  let adapter: InstanceType<typeof WhatsAppAdapter>;

  beforeEach(() => {
    adapter = new WhatsAppAdapter();
  });

  it("accepts a request whose X-Hub-Signature-256 matches the HMAC-SHA256 of the raw body using WHATSAPP_APP_SECRET", async () => {
    const req = signedRequest({ object: "whatsapp_business_account", entry: [] });
    expect(await adapter.validateWebhook(req)).toBe(true);
  });

  it("rejects a request whose body was tampered with after signing (signature no longer matches)", async () => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const signature = `sha256=${createHmac("sha256", "test-app-secret").update(raw).digest("hex")}`;
    const tampered = new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
      body: JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "injected" }] }),
    });
    expect(await adapter.validateWebhook(tampered)).toBe(false);
  });

  it("rejects a request signed with the wrong secret", async () => {
    const req = signedRequest({ object: "whatsapp_business_account", entry: [] }, "wrong-secret");
    expect(await adapter.validateWebhook(req)).toBe(false);
  });

  it("rejects a request with no X-Hub-Signature-256 header at all", async () => {
    const req = new Request("https://example.com/webhook", { method: "POST", body: "{}" });
    expect(await adapter.validateWebhook(req)).toBe(false);
  });

  it("rejects a header missing the 'sha256=' prefix", async () => {
    const raw = "{}";
    const bareHex = createHmac("sha256", "test-app-secret").update(raw).digest("hex");
    const req = new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": bareHex },
      body: raw,
    });
    expect(await adapter.validateWebhook(req)).toBe(false);
  });

  it("leaves the original request's body readable afterward (clone-before-read, not consume-then-fail)", async () => {
    const req = signedRequest({ object: "whatsapp_business_account", entry: [{ id: "x" }] });
    expect(await adapter.validateWebhook(req)).toBe(true);
    const body = (await req.json()) as { entry: unknown[] };
    expect(body.entry).toHaveLength(1);
  });
});

describe("WhatsAppAdapter.sendMessage", () => {
  let adapter: InstanceType<typeof WhatsAppAdapter>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new WhatsAppAdapter();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs a text message to the Graph API messages endpoint and returns SENT with the WhatsApp message id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messaging_product: "whatsapp", messages: [{ id: "wamid.OUT1" }] }));

    const result = await adapter.sendMessage({
      channelAccount: {} as never,
      externalContactId: "5215512345678",
      text: "Hello!",
    });

    expect(result).toEqual({ externalMessageId: "wamid.OUT1", status: "SENT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/1234567890/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-access-token");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "5215512345678",
      type: "text",
      text: { preview_url: false, body: "Hello!" },
    });
  });

  it("includes a context.message_id when replyToExternalId is set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.OUT2" }] }));
    await adapter.sendMessage({
      channelAccount: {} as never,
      externalContactId: "5215512345678",
      text: "Reply",
      replyToExternalId: "wamid.PARENT",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ context: { message_id: "wamid.PARENT" } });
  });

  it("throws UpstreamAdapterError with a permanent classification on a 400 (invalid recipient)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid recipient phone number", code: 131030 } }, 400));

    try {
      await adapter.sendMessage({ channelAccount: {} as never, externalContactId: "bad-number", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAdapterError);
      expect(classifyAdapterFailure(error)).toBe("permanent");
    }
  });

  it("throws UpstreamAdapterError with a transient classification on a 429 (rate limited)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "Too many requests" } }, 429));

    try {
      await adapter.sendMessage({ channelAccount: {} as never, externalContactId: "5215512345678", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAdapterError);
      expect(classifyAdapterFailure(error)).toBe("transient");
    }
  });

  it("throws UpstreamAdapterError with a transient classification on a 500", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "Internal error" } }, 500));

    try {
      await adapter.sendMessage({ channelAccount: {} as never, externalContactId: "5215512345678", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(classifyAdapterFailure(error)).toBe("transient");
    }
  });

  it("throws a transient UpstreamAdapterError on a network-level failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    try {
      await adapter.sendMessage({ channelAccount: {} as never, externalContactId: "5215512345678", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAdapterError);
      expect(classifyAdapterFailure(error)).toBe("transient");
    }
  });
});

describe("WhatsAppAdapter.sendTemplateMessage", () => {
  let adapter: InstanceType<typeof WhatsAppAdapter>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new WhatsAppAdapter();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs a template message with the correct request shape and returns SENT on success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.TEMPLATE1" }] }));

    const result = await adapter.sendTemplateMessage({
      externalContactId: "5215512345678",
      templateName: "order_confirmation",
      languageCode: "es_MX",
      components: [{ type: "body", parameters: [{ type: "text", text: "12345" }] }],
    });

    expect(result).toEqual({ externalMessageId: "wamid.TEMPLATE1", status: "SENT" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/1234567890/messages");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      messaging_product: "whatsapp",
      to: "5215512345678",
      type: "template",
      template: {
        name: "order_confirmation",
        language: { code: "es_MX" },
        components: [{ type: "body", parameters: [{ type: "text", text: "12345" }] }],
      },
    });
  });

  it("omits components entirely when none are supplied", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.TEMPLATE2" }] }));
    await adapter.sendTemplateMessage({ externalContactId: "5215512345678", templateName: "simple_ping", languageCode: "en_US" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.template.components).toBeUndefined();
  });

  it("throws UpstreamAdapterError (permanent) when the template isn't approved/doesn't exist", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Template name does not exist in the translation.", code: 132001 } }, 400));

    await expect(
      adapter.sendTemplateMessage({ externalContactId: "5215512345678", templateName: "nonexistent", languageCode: "en_US" }),
    ).rejects.toThrow(UpstreamAdapterError);
  });
});

describe("WhatsAppAdapter — NotConfiguredError when credentials are missing", () => {
  // `env.ts` itself already refuses to boot with `WHATSAPP_ENABLED=true` and a missing
  // access token/phone number id (§6.7's conditional-requirement validation — see
  // env.test.ts), so that exact combination can never occur through the REAL env module in
  // a running process. `requireCredentials()`/`healthCheck()`'s own guards are still real
  // defense-in-depth (e.g. against a future refactor of env.ts's invariant, or any code path
  // that constructs an adapter against a differently-validated env), so this test exercises
  // them directly via `vi.doMock` on the `env` module — bypassing real env.ts validation
  // entirely — rather than trying to reach an unreachable real-world process state.
  afterEach(() => {
    vi.doUnmock("../../env");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sendMessage throws NotConfiguredError if WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID aren't set", async () => {
    // A safety net, not the point of this test: if the env mock below somehow didn't take
    // effect, this stub still guarantees no live network call happens.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected live network call in test")));

    vi.resetModules();
    // Spread over the REAL env (`vi.importActual`) rather than replacing the module wholesale
    // — logger.ts (transitively imported by errors.ts) also reads `env.LOG_LEVEL`/`env.NODE_ENV`,
    // so a bare `{ env: { WHATSAPP_ACCESS_TOKEN: undefined } }` factory would leave those
    // unset and crash pino's construction with an unrelated error.
    vi.doMock("../../env", async () => {
      const actual = await vi.importActual<typeof import("../../env")>("../../env");
      return { env: { ...actual.env, WHATSAPP_ENABLED: true, WHATSAPP_ACCESS_TOKEN: undefined, WHATSAPP_PHONE_NUMBER_ID: undefined } };
    });

    const { WhatsAppAdapter: FreshAdapter } = await import("./adapter");
    const { NotConfiguredError: FreshNotConfiguredError } = await import("../../errors");
    const adapter = new FreshAdapter();

    await expect(adapter.sendMessage({ channelAccount: {} as never, externalContactId: "555", text: "hi" })).rejects.toThrow(
      FreshNotConfiguredError,
    );
  });
});

describe("WhatsAppAdapter.healthCheck", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports healthy with the phone number's display name on a successful Graph API call", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ display_phone_number: "+1 555 000 1111", verified_name: "Acme Demo Co" }));

    const adapter = new WhatsAppAdapter();
    const health = await adapter.healthCheck();
    expect(health).toEqual({ healthy: true, detail: "+1 555 000 1111" });
  });

  it("reports unhealthy with a detail message when the Graph API call fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid OAuth access token" } }, 401));

    const adapter = new WhatsAppAdapter();
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("Invalid OAuth access token");
  });

  it("reports unhealthy on a network-level failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    const adapter = new WhatsAppAdapter();
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.detail).toBeTruthy();
  });

  it("returns {healthy: false, detail: ...} without throwing when WHATSAPP_ENABLED is false, even if called directly", async () => {
    vi.resetModules();
    const originalEnabled = process.env.WHATSAPP_ENABLED;
    process.env.WHATSAPP_ENABLED = "false";

    const { WhatsAppAdapter: FreshAdapter } = await import("./adapter");
    const adapter = new FreshAdapter();
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.detail).toMatch(/not enabled/i);
    expect(fetchMock).not.toHaveBeenCalled();

    if (originalEnabled) process.env.WHATSAPP_ENABLED = originalEnabled;
    vi.resetModules();
  });

  it("returns {healthy: false, ...} without throwing when enabled but access token/phone number id are missing", async () => {
    // Same rationale as the `NotConfiguredError` describe block above: this exact
    // combination can't occur through the real, validated `env` module (env.ts refuses to
    // boot with WHATSAPP_ENABLED=true and a missing token), so `env` is mocked (spread over
    // the real module via `vi.importActual` so logger.ts's LOG_LEVEL/NODE_ENV reads still
    // work) to exercise `healthCheck()`'s own defensive guard in isolation.
    vi.resetModules();
    vi.doMock("../../env", async () => {
      const actual = await vi.importActual<typeof import("../../env")>("../../env");
      return { env: { ...actual.env, WHATSAPP_ENABLED: true, WHATSAPP_ACCESS_TOKEN: undefined, WHATSAPP_PHONE_NUMBER_ID: "1234567890" } };
    });

    const { WhatsAppAdapter: FreshAdapter } = await import("./adapter");
    const adapter = new FreshAdapter();
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.doUnmock("../../env");
    vi.resetModules();
  });
});

describe("WhatsAppAdapter.getDeliveryStatus", () => {
  it("always returns null (WhatsApp has no polling delivery-status API — see module doc comment)", async () => {
    const adapter = new WhatsAppAdapter();
    expect(await adapter.getDeliveryStatus()).toBeNull();
  });
});

describe("WhatsAppAdapter.parseInboundWebhook", () => {
  it("delegates to normalizeWhatsAppMessages", async () => {
    const adapter = new WhatsAppAdapter();
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID",
          changes: [
            {
              value: {
                metadata: { phone_number_id: "1234567890" },
                messages: [{ from: "5215512345678", id: "wamid.X", timestamp: "1753531200", type: "text", text: { body: "hi" } }],
              },
            },
          ],
        },
      ],
    };
    const req = new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const normalized = await adapter.parseInboundWebhook(req);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].externalContactId).toBe("5215512345678");
    expect(normalized[0].text).toBe("hi");
  });
});
