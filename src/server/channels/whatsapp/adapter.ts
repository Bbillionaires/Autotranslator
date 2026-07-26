/**
 * `WhatsAppAdapter` — the WhatsApp Business Cloud API channel adapter, per
 * docs/implementation-plan.md §3.2/§6.3/§5 and the Phase 9 task brief.
 *
 * Unlike `AndroidSmsAdapter` (Phase 8), this adapter calls OUT to a real cloud API
 * synchronously — same shape as `TelegramAdapter` (Phase 6): `sendMessage()` posts to Meta's
 * Graph API and returns `status: "SENT"` once Graph API's synchronous `200` response
 * confirms *acceptance* (not delivery — that's tracked separately via webhook status
 * callbacks, see `../../messaging/deliveryStatusService.ts`).
 *
 * ## The single hardest constraint (read this before touching anything here)
 * `WHATSAPP_ENABLED` defaults to `false`, and when it is, **zero** `WHATSAPP_*` env vars are
 * required (`src/server/env.ts`'s conditional-requirement logic), this adapter is never
 * registered (`../index.ts`), and every method here must behave gracefully if somehow
 * invoked anyway (mainly `healthCheck()` — see its doc comment) rather than throwing an
 * unhandled exception. `requireCredentials()` throws the documented `NotConfiguredError` for
 * everything else (`sendMessage`/`sendTemplateMessage`), matching the precedent
 * `TelegramAdapter.requireBotToken()` already established — a `NotConfiguredError` is an
 * "expected" `AppError` subtype, safely converted to a generic client message by
 * `handleRouteError`/`toSafeActionError`, never a raw unhandled throw.
 *
 * ## Template messages (`sendTemplateMessage`)
 * WhatsApp requires a pre-approved message template to *initiate* a conversation outside the
 * 24-hour customer-service window (a business can freely reply within 24h of the customer's
 * last message using a plain text message — `sendMessage` below — but starting a new
 * conversation, or resuming one after the window closes, requires a template Meta has
 * already approved for this WhatsApp Business Account). This is NOT part of the
 * `MessagingChannelAdapter` interface (`../types.ts`) because no other channel in this
 * codebase has an equivalent concept, and the interface's `sendMessage`/`SendMessageInput`
 * shape (plain `text`) has no field for a template name/variables — bolting that on to the
 * shared interface would leak a WhatsApp-specific concept into every other adapter's
 * contract. It's implemented here as a WhatsApp-specific extension method (same precedent as
 * `TelegramAdapter.sendRawMessage`/`getBotInfo`, `AndroidSmsAdapter.getDeviceHealth`) that a
 * future outbound-lifecycle enhancement (deciding whether the 24h window is open) can call
 * directly by importing `WhatsAppAdapter`. No real WhatsApp Business Account/approved
 * template exists to test this against live — the request shape and response handling are
 * implemented and tested with mocked `fetch` only (see adapter.test.ts).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../env";
import { NotConfiguredError, UpstreamAdapterError } from "../../errors";
import type {
  DeliveryStatusUpdate,
  MessagingChannelAdapter,
  NormalizedInboundMessage,
  SendMessageInput,
  SendMessageResult,
} from "../types";
import { normalizeWhatsAppMessages, type WhatsAppWebhookPayload } from "./parse";

const GRAPH_API_BASE = "https://graph.facebook.com";
/**
 * Graph API version pinned here rather than via a new env var — the task brief lists
 * exactly five conditionally-required `WHATSAPP_*` vars (§6.7/§7); adding a sixth,
 * unrequired one for a detail this unlikely to change per-deployment would be scope creep.
 * Bump this constant (and re-test) if/when Meta deprecates the pinned version.
 */
const GRAPH_API_VERSION = "v21.0";

interface GraphApiErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

interface GraphApiSendResponse {
  messages?: Array<{ id: string }>;
}

interface GraphApiPhoneNumberResponse {
  display_phone_number?: string;
  verified_name?: string;
}

export interface SendTemplateMessageInput {
  externalContactId: string;
  templateName: string;
  languageCode: string;
  /** Meta's `template.components` array (header/body/button variable substitutions). Passed through verbatim — this adapter doesn't validate it against a real template definition (none exists in this sandbox). */
  components?: unknown[];
}

function requireCredentials(): { accessToken: string; phoneNumberId: string } {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new NotConfiguredError("WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID must both be configured.");
  }
  return { accessToken: env.WHATSAPP_ACCESS_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID };
}

async function safeJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * Constant-time string comparison — same pattern as `TelegramAdapter`'s local
 * `constantTimeEquals`/`androidAuth.ts`'s local helper (one small self-contained copy per
 * file rather than a premature shared abstraction, per that module's precedent). Falls back
 * to comparing a buffer against itself on length mismatch (still constant-time for that
 * buffer's length) since `timingSafeEqual` requires equal-length inputs and an early
 * `return false` would itself leak the secret's length via timing.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export class WhatsAppAdapter implements MessagingChannelAdapter {
  readonly channelType = "WHATSAPP" as const;

  /** Shared by `sendMessage`/`sendTemplateMessage` — both POST to the same `/messages` endpoint, differing only in body shape. */
  private async postMessage(body: Record<string, unknown>): Promise<SendMessageResult> {
    const { accessToken, phoneNumberId } = requireCredentials();
    const url = `${GRAPH_API_BASE}/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      });
    } catch (error) {
      // Network-level failure (DNS, timeout, connection reset, ...) — always transient.
      throw new UpstreamAdapterError("WhatsApp Graph API network error calling /messages", {
        transient: true,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const parsed = await safeJson<GraphApiSendResponse & GraphApiErrorBody>(response);

    if (!response.ok || !parsed?.messages?.[0]?.id) {
      // `classifyAdapterFailure` (../../messaging/failureClassifier.ts) reads `detail.status`
      // as an HTTP-style code: 429 -> transient, >=500 -> transient, >=400 -> permanent
      // (matches the task brief: "rate-limit/5xx transient, invalid-recipient/permanently-
      // blocked permanent" — Graph API returns 4xx for both of those cases).
      throw new UpstreamAdapterError(parsed?.error?.message ?? `WhatsApp API call to /messages failed (${response.status})`, {
        status: response.status,
      });
    }

    return { externalMessageId: parsed.messages[0].id, status: "SENT" };
  }

  /**
   * Part of `MessagingChannelAdapter` — used by the outbound lifecycle (§3.6). Sends a
   * plain text message. Graph API's synchronous `200` response with a `messages[].id` IS
   * acceptance (unlike `AndroidSmsAdapter`'s inverted "queued for later pickup" flow) — this
   * adapter returns `"SENT"` immediately, same precedent as `TelegramAdapter.sendMessage`.
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    return this.postMessage({
      to: input.externalContactId,
      type: "text",
      text: { preview_url: false, body: input.text },
      ...(input.replyToExternalId ? { context: { message_id: input.replyToExternalId } } : {}),
    });
  }

  /**
   * NOT part of `MessagingChannelAdapter` — see the module doc comment's "Template messages"
   * section for why. Sends a pre-approved WhatsApp template message (required to initiate a
   * conversation outside the 24-hour customer-service window). No live template is
   * registered anywhere in this sandbox; this implements the correct Graph API request shape
   * and response handling, exercised only against a mocked `fetch` in adapter.test.ts.
   */
  async sendTemplateMessage(input: SendTemplateMessageInput): Promise<SendMessageResult> {
    return this.postMessage({
      to: input.externalContactId,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        ...(input.components ? { components: input.components } : {}),
      },
    });
  }

  /**
   * `X-Hub-Signature-256` HMAC-SHA256 of the RAW request body using `WHATSAPP_APP_SECRET`,
   * per §6.3. Critically, this reads the raw bytes via `req.clone().text()` — cloning
   * BEFORE consuming the body means the original `req` passed in is left untouched, so the
   * caller (the webhook route) can still read the body itself afterward (`req.text()`/
   * `req.json()`) exactly once. This sidesteps the classic bug the task brief warns about
   * (parse JSON first, then re-`JSON.stringify()` to check the signature — which can mismatch
   * on whitespace/key-order): the HMAC here is always computed over the *exact* bytes Meta
   * sent, never a re-serialized reconstruction.
   */
  async validateWebhook(req: Request): Promise<boolean> {
    const secret = env.WHATSAPP_APP_SECRET;
    if (!secret) return false;

    const header = req.headers.get("x-hub-signature-256");
    if (!header || !header.startsWith("sha256=")) return false;

    const rawBody = await req.clone().text();
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    return constantTimeEquals(header, expected);
  }

  /**
   * Part of `MessagingChannelAdapter` — kept for interface conformance and isolated unit
   * testing (see parse.ts's doc comment on `normalizeWhatsAppMessages` for why this
   * flattened form isn't what the LIVE webhook route calls: the route needs each `value`
   * block's own `phone_number_id` to resolve the correct `ChannelAccount`, which this
   * interface-shaped method doesn't surface — it uses `extractWhatsAppValueBlocks` directly
   * instead, same precedent as `TelegramAdapter`'s route bypassing `parseInboundWebhook`).
   */
  async parseInboundWebhook(req: Request): Promise<NormalizedInboundMessage[]> {
    const payload = (await req.json()) as WhatsAppWebhookPayload;
    return normalizeWhatsAppMessages(payload);
  }

  /**
   * Always `null`: WhatsApp has no pull/polling API for delivery status either — status
   * updates arrive exclusively via the `statuses[]` webhook callback branch (handled by
   * `../../messaging/deliveryStatusService.ts`, called from the webhook route), never by
   * polling this method. Same "always null" precedent as `TelegramAdapter.getDeliveryStatus`/
   * `AndroidSmsAdapter.getDeliveryStatus`.
   */
  async getDeliveryStatus(): Promise<DeliveryStatusUpdate | null> {
    return null;
  }

  /**
   * A lightweight Graph API call (fetching this number's own phone-number info) to confirm
   * the access token/phone-number-id pair is valid and reachable. Must not throw when
   * WhatsApp isn't configured — `registerChannelAdapters()`/the registry already guard
   * against this adapter being registered at all when `WHATSAPP_ENABLED` is false, but this
   * method defends in depth (and is directly unit-testable in isolation, e.g. a test that
   * `new WhatsAppAdapter()`s and calls `healthCheck()` with the flag off) per the task
   * brief's explicit requirement: "return `{healthy: false, detail: ...}`", never an
   * unhandled exception.
   */
  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    if (!env.WHATSAPP_ENABLED) {
      return { healthy: false, detail: "WhatsApp is not enabled (WHATSAPP_ENABLED=false)." };
    }
    if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
      return { healthy: false, detail: "WhatsApp is enabled but WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID are not both configured." };
    }

    try {
      const url = `${GRAPH_API_BASE}/${GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=verified_name,display_phone_number`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } });
      const parsed = await safeJson<GraphApiPhoneNumberResponse & GraphApiErrorBody>(response);

      if (!response.ok) {
        return { healthy: false, detail: parsed?.error?.message ?? `Graph API returned ${response.status}` };
      }
      return { healthy: true, detail: parsed?.display_phone_number ?? parsed?.verified_name ?? "Connected" };
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : "Unknown error" };
    }
  }
}

export const whatsAppAdapter = new WhatsAppAdapter();
