/**
 * `WhatsAppAdapter` — the WhatsApp Business Cloud API channel adapter, per
 * docs/implementation-plan.md §3.2/§6.3/§5.
 *
 * ## Per-organization credentials
 * Each organization connects its OWN WhatsApp Business Cloud API credentials (access token,
 * phone number id, business account id, app secret, verify token — entered in Settings, see
 * `src/server/actions/whatsapp.ts`) rather than this deployment sharing one global set of
 * `WHATSAPP_*` env vars. Every method here that calls the Graph API or verifies a webhook
 * therefore needs the specific org's decrypted credentials: `sendMessage`/
 * `sendTemplateMessage` (via `input.channelAccount`, part of `MessagingChannelAdapter`'s
 * `SendMessageInput`), and `checkAccountHealth`/webhook-signature verification take an
 * explicit `WhatsAppCredentials` or `ChannelAccount` parameter.
 *
 * `WHATSAPP_ENABLED` remains a global feature flag — when false (default), this adapter is
 * never registered (`../index.ts`) and every WhatsApp route is inert, exactly as before.
 * What changed is that flipping the flag on no longer requires (or reads) any
 * `WHATSAPP_ACCESS_TOKEN`-shaped global env var — credentials live per-`ChannelAccount`.
 *
 * ## Template messages (`sendTemplateMessage`)
 * WhatsApp requires a pre-approved message template to *initiate* a conversation outside the
 * 24-hour customer-service window (a business can freely reply within 24h of the customer's
 * last message using a plain text message — `sendMessage` below — but starting a new
 * conversation, or resuming one after the window closes, requires a template Meta has
 * already approved for this WhatsApp Business Account). This is NOT part of the
 * `MessagingChannelAdapter` interface (`../types.ts`) because no other channel in this
 * codebase has an equivalent concept. No real WhatsApp Business Account/approved template
 * exists to test this against live — the request shape and response handling are
 * implemented and tested with mocked `fetch` only (see adapter.test.ts).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelAccount } from "@prisma/client";
import { UpstreamAdapterError } from "../../errors";
import type {
  DeliveryStatusUpdate,
  MessagingChannelAdapter,
  NormalizedInboundMessage,
  SendMessageInput,
  SendMessageResult,
} from "../types";
import { decryptWhatsAppCredentials, type WhatsAppCredentials } from "./credentials";
import { normalizeWhatsAppMessages, type WhatsAppWebhookPayload } from "./parse";

const GRAPH_API_BASE = "https://graph.facebook.com";
/**
 * Graph API version pinned here rather than via a new env var — the five per-org
 * credential fields (§6.7/§7) are already a lot of Settings-form surface; adding a sixth,
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
  channelAccount: ChannelAccount;
  externalContactId: string;
  templateName: string;
  languageCode: string;
  /** Meta's `template.components` array (header/body/button variable substitutions). Passed through verbatim — this adapter doesn't validate it against a real template definition (none exists in this sandbox). */
  components?: unknown[];
}

async function safeJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

/**
 * Constant-time string comparison — same pattern as `TelegramAdapter`'s exported
 * `constantTimeEquals`/`androidAuth.ts`'s local helper (one small self-contained copy per
 * file rather than a premature shared abstraction, per that module's precedent). Falls back
 * to comparing a buffer against itself on length mismatch (still constant-time for that
 * buffer's length) since `timingSafeEqual` requires equal-length inputs and an early
 * `return false` would itself leak the secret's length via timing.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies `X-Hub-Signature-256` (HMAC-SHA256 of the RAW request body) against a specific
 * organization's own `appSecret` — exported so the per-account webhook route
 * (`src/app/api/channels/whatsapp/webhook/[channelAccountId]/route.ts`) can call it once
 * that route has already resolved which `ChannelAccount` (and therefore which `appSecret`)
 * the URL names, sidestepping the old "peek inside the body for phone_number_id before
 * knowing which secret to verify with" problem entirely.
 */
export function verifyWhatsAppSignature(header: string | null, rawBody: string, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return constantTimeEquals(header, expected);
}

export class WhatsAppAdapter implements MessagingChannelAdapter {
  readonly channelType = "WHATSAPP" as const;

  /** Shared by `sendMessage`/`sendTemplateMessage` — both POST to the same `/messages` endpoint, differing only in body shape. */
  private async postMessage(credentials: WhatsAppCredentials, body: Record<string, unknown>): Promise<SendMessageResult> {
    const { accessToken, phoneNumberId } = credentials;
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
      // (matches: "rate-limit/5xx transient, invalid-recipient/permanently-blocked
      // permanent" — Graph API returns 4xx for both of those cases).
      throw new UpstreamAdapterError(parsed?.error?.message ?? `WhatsApp API call to /messages failed (${response.status})`, {
        status: response.status,
      });
    }

    return { externalMessageId: parsed.messages[0].id, status: "SENT" };
  }

  /**
   * Part of `MessagingChannelAdapter` — used by the outbound lifecycle (§3.6). Decrypts this
   * specific org's WhatsApp credentials from `input.channelAccount.encryptedCredentials`.
   * Sends a plain text message. Graph API's synchronous `200` response with a
   * `messages[].id` IS acceptance (unlike `AndroidSmsAdapter`'s inverted "queued for later
   * pickup" flow) — this adapter returns `"SENT"` immediately, same precedent as
   * `TelegramAdapter.sendMessage`.
   */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const credentials = decryptWhatsAppCredentials(input.channelAccount);
    return this.postMessage(credentials, {
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
    const credentials = decryptWhatsAppCredentials(input.channelAccount);
    return this.postMessage(credentials, {
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
   * Part of `MessagingChannelAdapter` — kept for interface conformance and isolated unit
   * testing (see parse.ts's doc comment on `normalizeWhatsAppMessages` for why this
   * flattened form isn't what the LIVE webhook route calls — it uses
   * `extractWhatsAppValueBlocks` directly instead).
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
   * Interface-required, parameterless — there is no single global WhatsApp account to check
   * any more (each org has its own), so this can only ever report that the adapter is
   * registered. Real per-organization health is `checkAccountHealth` below.
   */
  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: true, detail: "WhatsApp adapter registered. Connect an account in Settings to check its own health." };
  }

  /**
   * Real per-organization connection health: decrypts `channelAccount`'s own credentials and
   * delegates to `checkCredentialsHealth` below.
   */
  async checkAccountHealth(channelAccount: ChannelAccount): Promise<{ healthy: boolean; detail?: string }> {
    try {
      return await this.checkCredentialsHealth(decryptWhatsAppCredentials(channelAccount));
    } catch (error) {
      return { healthy: false, detail: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  /**
   * The same Graph API "fetch this phone number's own info" health probe as
   * `checkAccountHealth`, but taking already-decrypted credentials directly rather than a
   * stored `ChannelAccount` — used by the "connect a WhatsApp account" Server Action
   * (`src/server/actions/whatsapp.ts`) to validate a freshly-submitted credentials form
   * BEFORE it's ever encrypted/saved, so a typo'd access token or phone number id is caught
   * immediately rather than silently stored.
   */
  async checkCredentialsHealth(credentials: WhatsAppCredentials): Promise<{ healthy: boolean; detail?: string }> {
    try {
      const { accessToken, phoneNumberId } = credentials;
      const url = `${GRAPH_API_BASE}/${GRAPH_API_VERSION}/${phoneNumberId}?fields=verified_name,display_phone_number`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
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
