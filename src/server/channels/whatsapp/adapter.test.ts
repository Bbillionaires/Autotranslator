/**
 * Unit tests for `WhatsAppAdapter`, rewritten for per-organization WhatsApp credentials. No
 * live network call is ever made — `global.fetch` is mocked in every test.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NOTE: env-dependent modules must be dynamically imported AFTER the process.env
// assignments below — same rationale as telegram/adapter.test.ts's top-of-file comment
// (static imports are hoisted and would freeze `env.CREDENTIAL_ENCRYPTION_KEY` as undefined).
process.env.WHATSAPP_ENABLED ??= "true";
process.env.CREDENTIAL_ENCRYPTION_KEY ??= "fa".repeat(32);

const { UpstreamAdapterError } = await import("../../errors");
const { WhatsAppAdapter, verifyWhatsAppSignature } = await import("./adapter");
const { classifyAdapterFailure } = await import("../../messaging/failureClassifier");
const { encryptWhatsAppCredentials } = await import("./credentials");

const FIXED_CREDENTIALS = {
  accessToken: "test-access-token",
  phoneNumberId: "1234567890",
  businessAccountId: "waba-test-id",
  appSecret: "test-app-secret",
  verifyToken: "test-verify-token",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeChannelAccount(credentials: typeof FIXED_CREDENTIALS = FIXED_CREDENTIALS) {
  return { encryptedCredentials: encryptWhatsAppCredentials(credentials) } as never;
}

describe("verifyWhatsAppSignature", () => {
  it("accepts a signature computed over the raw body with the correct appSecret", () => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const header = `sha256=${createHmac("sha256", "test-app-secret").update(raw).digest("hex")}`;
    expect(verifyWhatsAppSignature(header, raw, "test-app-secret")).toBe(true);
  });

  it("rejects a body that was tampered with after signing", () => {
    const original = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const header = `sha256=${createHmac("sha256", "test-app-secret").update(original).digest("hex")}`;
    const tampered = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "injected" }] });
    expect(verifyWhatsAppSignature(header, tampered, "test-app-secret")).toBe(false);
  });

  it("rejects a signature computed with a DIFFERENT organization's appSecret", () => {
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const header = `sha256=${createHmac("sha256", "org-a-secret").update(raw).digest("hex")}`;
    expect(verifyWhatsAppSignature(header, raw, "org-b-secret")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyWhatsAppSignature(null, "{}", "test-app-secret")).toBe(false);
  });

  it("rejects a header missing the 'sha256=' prefix", () => {
    const raw = "{}";
    const bareHex = createHmac("sha256", "test-app-secret").update(raw).digest("hex");
    expect(verifyWhatsAppSignature(bareHex, raw, "test-app-secret")).toBe(false);
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

  it("decrypts this org's own credentials and POSTs a text message to the Graph API messages endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messaging_product: "whatsapp", messages: [{ id: "wamid.OUT1" }] }));

    const result = await adapter.sendMessage({
      channelAccount: fakeChannelAccount(),
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

  it("uses a DIFFERENT organization's own phoneNumberId/accessToken when given a different channelAccount", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.A" }] }));
    await adapter.sendMessage({
      channelAccount: fakeChannelAccount({ ...FIXED_CREDENTIALS, accessToken: "org-a-token", phoneNumberId: "111" }),
      externalContactId: "1",
      text: "hi",
    });
    const [urlA, initA] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(urlA).toContain("111");
    expect((initA.headers as Record<string, string>).Authorization).toBe("Bearer org-a-token");

    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.B" }] }));
    await adapter.sendMessage({
      channelAccount: fakeChannelAccount({ ...FIXED_CREDENTIALS, accessToken: "org-b-token", phoneNumberId: "222" }),
      externalContactId: "1",
      text: "hi",
    });
    const [urlB, initB] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(urlB).toContain("222");
    expect((initB.headers as Record<string, string>).Authorization).toBe("Bearer org-b-token");
    expect(urlA).not.toBe(urlB);
  });

  it("includes a context.message_id when replyToExternalId is set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.OUT2" }] }));
    await adapter.sendMessage({
      channelAccount: fakeChannelAccount(),
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
      await adapter.sendMessage({ channelAccount: fakeChannelAccount(), externalContactId: "bad-number", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAdapterError);
      expect(classifyAdapterFailure(error)).toBe("permanent");
    }
  });

  it("throws UpstreamAdapterError with a transient classification on a 429 (rate limited)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "Too many requests" } }, 429));

    try {
      await adapter.sendMessage({ channelAccount: fakeChannelAccount(), externalContactId: "5215512345678", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAdapterError);
      expect(classifyAdapterFailure(error)).toBe("transient");
    }
  });

  it("throws UpstreamAdapterError with a transient classification on a 500", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: "Internal error" } }, 500));

    try {
      await adapter.sendMessage({ channelAccount: fakeChannelAccount(), externalContactId: "5215512345678", text: "Hi" });
      expect.fail("expected sendMessage to throw");
    } catch (error) {
      expect(classifyAdapterFailure(error)).toBe("transient");
    }
  });

  it("throws a transient UpstreamAdapterError on a network-level failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    try {
      await adapter.sendMessage({ channelAccount: fakeChannelAccount(), externalContactId: "5215512345678", text: "Hi" });
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
      channelAccount: fakeChannelAccount(),
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
    await adapter.sendTemplateMessage({
      channelAccount: fakeChannelAccount(),
      externalContactId: "5215512345678",
      templateName: "simple_ping",
      languageCode: "en_US",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.template.components).toBeUndefined();
  });

  it("throws UpstreamAdapterError (permanent) when the template isn't approved/doesn't exist", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Template name does not exist in the translation.", code: 132001 } }, 400));

    await expect(
      adapter.sendTemplateMessage({
        channelAccount: fakeChannelAccount(),
        externalContactId: "5215512345678",
        templateName: "nonexistent",
        languageCode: "en_US",
      }),
    ).rejects.toThrow(UpstreamAdapterError);
  });
});

describe("WhatsAppAdapter — errors when a channelAccount has no stored credentials", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sendMessage throws when the channelAccount has no encryptedCredentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected live network call in test")));
    const adapter = new WhatsAppAdapter();

    await expect(
      adapter.sendMessage({ channelAccount: { encryptedCredentials: null } as never, externalContactId: "555", text: "hi" }),
    ).rejects.toThrow();
  });
});

describe("WhatsAppAdapter.checkCredentialsHealth / checkAccountHealth", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checkCredentialsHealth reports healthy with the phone number's display name on a successful Graph API call", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ display_phone_number: "+1 555 000 1111", verified_name: "Acme Demo Co" }));

    const adapter = new WhatsAppAdapter();
    const health = await adapter.checkCredentialsHealth(FIXED_CREDENTIALS);
    expect(health).toEqual({ healthy: true, detail: "+1 555 000 1111" });
  });

  it("checkAccountHealth decrypts the channelAccount's own credentials and reports the same result", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ display_phone_number: "+1 555 000 2222" }));
    const adapter = new WhatsAppAdapter();
    const health = await adapter.checkAccountHealth(fakeChannelAccount());
    expect(health).toEqual({ healthy: true, detail: "+1 555 000 2222" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(FIXED_CREDENTIALS.phoneNumberId);
  });

  it("reports unhealthy with a detail message when the Graph API call fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid OAuth access token" } }, 401));

    const adapter = new WhatsAppAdapter();
    const health = await adapter.checkCredentialsHealth(FIXED_CREDENTIALS);
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("Invalid OAuth access token");
  });

  it("reports unhealthy on a network-level failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    const adapter = new WhatsAppAdapter();
    const health = await adapter.checkCredentialsHealth(FIXED_CREDENTIALS);
    expect(health.healthy).toBe(false);
    expect(health.detail).toBeTruthy();
  });

  it("checkAccountHealth reports unhealthy (without throwing) when the account has no stored credentials", async () => {
    const adapter = new WhatsAppAdapter();
    const health = await adapter.checkAccountHealth({ encryptedCredentials: null } as never);
    expect(health.healthy).toBe(false);
  });
});

describe("WhatsAppAdapter.healthCheck (parameterless, interface-required)", () => {
  it("reports the adapter as registered, without needing any per-org credential", async () => {
    const adapter = new WhatsAppAdapter();
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(true);
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
