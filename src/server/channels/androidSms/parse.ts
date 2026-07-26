/**
 * Android gateway inbound-SMS normalization, per docs/implementation-plan.md §3.2/§3.5 and
 * the Phase 8 task brief.
 *
 * Unlike Telegram/WhatsApp, inbound SMS never arrives as an unauthenticated webhook payload
 * this module has to independently validate a signature for — the device already
 * authenticated itself (`../../gateways/androidAuth.ts`'s `authenticateDevice`) before this
 * normalization ever runs; `POST /api/gateways/inbound` (the route handler) does that auth
 * step and Zod-validates the body (`../../validation/androidGateway.ts`'s
 * `inboundSmsSchema`) BEFORE calling `normalizeAndroidInboundSms` here — so this function
 * takes an already-validated `InboundSmsInput`, not a raw `Request`. Kept dependency-free
 * (no Prisma/env/logging), matching `telegram/parse.ts`'s precedent, so it's trivially
 * unit-testable against fixture payloads.
 */
import type { NormalizedInboundMessage } from "../types";
import type { InboundSmsInput } from "../../validation/androidGateway";

/**
 * Loose phone-number normalization: trims whitespace and strips common formatting
 * characters (spaces, dashes, dots, parens), preserving a leading `+`. Not a full E.164
 * validator/normalizer (no country-code inference) — deliberately simple for the MVP, same
 * spirit as `../../validation/glossary.ts`'s "loose BCP-47 validator, not exhaustive".
 * Documented as a known limitation in docs/channel-adapters.md (two devices reporting the
 * same number with different formatting would otherwise resolve to two different
 * `Contact`s).
 */
export function normalizePhoneNumber(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Normalizes a validated inbound-SMS payload into a `NormalizedInboundMessage`. The sender
 * phone number becomes both `externalContactId` (what `resolveOrCreateContactAndConversation`
 * matches an existing `ContactChannelIdentity` on) and `phoneNumber` (so a brand-new
 * `Contact` gets `Contact.phoneNumber` populated directly, unlike Telegram which has no
 * phone number to offer at all) — for SMS, "the phone number" and "the external contact id"
 * are the same underlying identity, there's no separate chat/user id concept.
 */
export function normalizeAndroidInboundSms(input: InboundSmsInput): NormalizedInboundMessage {
  const phoneNumber = normalizePhoneNumber(input.from);
  return {
    externalContactId: phoneNumber,
    phoneNumber,
    externalMessageId: input.externalMessageId,
    text: input.text,
    sentAt: input.sentAt,
    raw: input,
  };
}
