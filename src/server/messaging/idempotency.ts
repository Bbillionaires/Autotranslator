/**
 * Idempotency key derivation, per docs/implementation-plan.md §3.5 step 4 / §4.
 *
 * Pure functions, no Prisma/env/logging dependency — deliberately trivial to unit test in
 * isolation. `Message.idempotencyKey` is unique per organization
 * (`@@unique([organizationId, idempotencyKey])`); these two functions are the only
 * sanctioned way to derive it:
 *
 *   - Inbound: `sha256(channelAccountId + ":" + externalMessageId)` — deterministic, so a
 *     retried webhook for the same external message always maps to the same key.
 *   - Outbound: the client-supplied idempotency key (compose form), or a server-generated
 *     UUID fallback when the caller doesn't supply one.
 */
import { createHash, randomUUID } from "node:crypto";

/**
 * Derives the inbound dedupe key for a webhook message. Deterministic in
 * `(channelAccountId, externalMessageId)` — the same pair always produces the same key,
 * which is what lets a duplicate webhook delivery collapse onto the existing `Message` row
 * via the unique-constraint catch in `inboundService.ts` instead of a separate pre-check.
 */
export function deriveInboundIdempotencyKey(channelAccountId: string, externalMessageId: string): string {
  return createHash("sha256").update(`${channelAccountId}:${externalMessageId}`).digest("hex");
}

/**
 * Resolves the outbound idempotency key: the caller-supplied key (typically a client-
 * generated UUID from the compose form) if present and non-empty, otherwise a fresh
 * server-generated UUID. Regenerating server-side as a fallback (rather than requiring the
 * caller to always supply one) is what protects a caller that forgot to generate a key
 * client-side, at the cost of no longer being idempotent across genuinely separate calls —
 * acceptable because a client that cares about idempotency (protecting against
 * double-submit/network retry) is expected to always pass its own key.
 */
export function deriveOutboundIdempotencyKey(clientSuppliedKey?: string | null): string {
  if (clientSuppliedKey && clientSuppliedKey.trim().length > 0) {
    return clientSuppliedKey.trim();
  }
  return randomUUID();
}
