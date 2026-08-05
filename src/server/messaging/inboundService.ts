/**
 * Inbound message lifecycle, per docs/implementation-plan.md §3.5 steps 4-9.
 *
 * `processInboundMessage` is the single orchestrating function a channel webhook Route
 * Handler calls after it has already validated the webhook signature (adapter's
 * `validateWebhook()`) and normalized the payload (adapter's `parseInboundWebhook()`) —
 * steps 1-3 of §3.5 are the adapter/route's job, not this service's. This function starts
 * at step 4 (dedupe) and runs through step 9 (store + bump `lastMessageAt`).
 *
 * Transaction note ("all in one Prisma transaction where feasible", per the Phase 5 brief):
 * `TranslationEngine.detectLanguage()`/`.translate()` call an external provider (OpenAI, in
 * production) and must NOT run inside an open `prisma.$transaction(...)` — holding a
 * Postgres transaction/connection open across a slow external HTTP call would exhaust the
 * connection pool under load. So this function uses two short transactions instead of one
 * long one: (1) resolve-or-create Contact + ContactChannelIdentity + Conversation, then
 * store the Message row itself + "received" MessageEvent + bump `Conversation.lastMessageAt`
 * (both DB-only), then the translation calls happen outside any transaction, then (2) a
 * final small update persisting the translation result (or failure). The "one Message row
 * per idempotencyKey" guarantee (the actual correctness requirement) is enforced by the
 * unique-constraint catch around the Message insert, which is race-safe regardless of how
 * many transactions surround it.
 *
 * T1 fix (docs/test-report.md — "Translation-provider failures are not caught anywhere in
 * the message pipeline; the message is not stored at all, not just 'degraded'"): the
 * Message row is now stored — with `originalText` and every channel/dedup field already
 * known at that point (`externalMessageId`, `idempotencyKey`, `conversation`, resolved
 * `targetLanguage`, and `sourceLanguage` if already known from the Contact) — as `PENDING`
 * *BEFORE* `engine.detectLanguage()`/`.translate()` is ever called, mirroring the "store
 * first" discipline `outboundService.sendMessage` already used for the send step. If
 * translation throws, the already-persisted row is transitioned to `FAILED` with a
 * `failureReason` (reusing `MessageStatus.FAILED` — the same terminal-failure state the
 * outbound lifecycle already uses for send failures — rather than inventing a distinct
 * status; an inbound "translation failed" and an outbound "send failed" are both "this
 * message did not complete its lifecycle and needs attention", so sharing one status keeps
 * `DeliveryStatusBadge`/dashboards/the retry-worker's "FAILED = look at me" query all
 * meaningful without a schema migration). The original text is never lost.
 *
 * Retry model for an inbound translation failure — deliberately MANUAL, not automatic: see
 * `retryInboundTranslation` below and `messageRepository.listFailedAwaitingRetry`'s doc
 * comment for the full rationale (short version: the automatic retry worker's retry path
 * assumes a send-oriented retry through a channel adapter, which doesn't exist for an
 * inbound message).
 */
import type { ChannelAccount, Contact, Conversation, Message } from "@prisma/client";
import { isUniqueConstraintViolation, prisma } from "../db";
import { ValidationError } from "../errors";
import { withContext } from "../logger";
import { organizationRepository } from "../repositories/organizationRepository";
import { contactRepository } from "../repositories/contactRepository";
import { conversationRepository } from "../repositories/conversationRepository";
import { messageEventRepository } from "../repositories/messageEventRepository";
import { messageRepository } from "../repositories/messageRepository";
import { userRepository } from "../repositories/userRepository";
import { TranslationEngine, translationEngine } from "../translation/engine";
import { resolveTargetLanguage } from "../translation/resolveLanguage";
import type { NormalizedInboundMessage } from "../channels/types";
import { resolveOrCreateContactAndConversation } from "./contactResolution";
import { classifyTranslationFailure } from "./failureClassifier";
import { transitionToFailed } from "./failureTransition";
import { deriveInboundIdempotencyKey } from "./idempotency";
import { assertValidTransition } from "./retryQueue";

export interface ProcessInboundMessageDeps {
  /** Override for tests (e.g. a `TranslationEngine` wrapping `NoopTranslationProvider`). Defaults to the process-wide `translationEngine`. */
  engine?: TranslationEngine;
}

export interface ProcessInboundMessageResult {
  message: Message;
  conversation: Conversation;
  contact: Contact;
  /** True when this call short-circuited onto an already-processed duplicate webhook instead of creating a new row. */
  wasDuplicate: boolean;
}

export async function processInboundMessage(
  normalized: NormalizedInboundMessage,
  channelAccount: ChannelAccount,
  deps: ProcessInboundMessageDeps = {},
): Promise<ProcessInboundMessageResult> {
  const engine = deps.engine ?? translationEngine;
  const organizationId = channelAccount.organizationId;
  const log = withContext({ organizationId, channelAccountId: channelAccount.id });

  // Step 4 (key derivation only — the dedupe check itself happens via unique-constraint
  // catch around the Message insert below, not a pre-check here).
  const idempotencyKey = deriveInboundIdempotencyKey(channelAccount.id, normalized.externalMessageId);

  // Step 5: resolve/create Contact + ContactChannelIdentity + canonical Conversation.
  const { contact, conversation } = await resolveOrCreateContactAndConversation(organizationId, channelAccount, {
    externalContactId: normalized.externalContactId,
    externalUsername: normalized.externalUsername,
    phoneNumber: normalized.phoneNumber,
  });

  let effectiveContact = contact;

  // Step 6 (partial, DB-only): if the Contact's language is already known, no
  // `detectLanguage()` call is needed at all. Whether or not that's true, this much can be
  // resolved before ever touching the translation provider — which is exactly what lets the
  // Message row below be stored with as much of `sourceLanguage`/`targetLanguage` filled in
  // as possible *before* any external call is attempted.
  let sourceLanguage: string | undefined = effectiveContact.preferredLanguage ?? effectiveContact.detectedLanguage ?? undefined;
  const needsLanguageDetection = !effectiveContact.preferredLanguage;

  // Step 7: resolve the receiver's (inbox viewer's) language — normally the assigned
  // user's preferredLanguage, mirroring the same priority chain used for outbound (§3.4):
  // conversation override first, then "the human on the receiving end"'s own preference,
  // falling back to the org default and finally "en". There is no per-conversation
  // "detected" equivalent for a human user, so that slot is always null here.
  const organization = await organizationRepository.findByIdOrThrow(organizationId);
  const assignedUser = conversation.assignedUserId
    ? await userRepository.findByIdInOrg(organizationId, conversation.assignedUserId)
    : null;
  const targetLanguage = resolveTargetLanguage({
    conversationOverride: conversation.preferredLanguageOverride,
    contactPreferred: assignedUser?.preferredLanguage ?? null,
    contactDetected: null,
    orgDefault: organization.defaultLanguage,
  });

  // T1 fix: store the Message row (status PENDING) + "received" MessageEvent + bump
  // Conversation.lastMessageAt, dedup'd via the idempotencyKey unique constraint (race-safe:
  // attempt the insert and catch P2002, rather than checking existence first) — all of this
  // BEFORE calling `engine.detectLanguage()`/`.translate()`, so the original text is durable
  // even if the translation provider is down. This also means a webhook retry that arrives
  // *after* a translation failure hits this exact same catch block and short-circuits onto
  // the already-created (now `FAILED`) row instead of erroring or double-processing.
  let message: Message;
  let touchedConversation: Conversation;
  try {
    const created = await prisma.$transaction(async (tx) => {
      const createdMessage = await messageRepository.create(
        {
          organizationId,
          conversationId: conversation.id,
          senderType: "CONTACT",
          direction: "INBOUND",
          originalText: normalized.text,
          sourceLanguage,
          targetLanguage,
          channelType: channelAccount.channelType,
          externalMessageId: normalized.externalMessageId,
          externalReplyToId: normalized.externalReplyToId ?? null,
          status: "PENDING",
          idempotencyKey,
        },
        tx,
      );

      await messageEventRepository.create(
        {
          messageId: createdMessage.id,
          eventType: "received",
          payload: (normalized.raw ?? null) as never,
        },
        tx,
      );

      const touched = await conversationRepository.touchLastMessageAt(organizationId, conversation.id, normalized.sentAt, tx);

      return { message: createdMessage, conversation: touched };
    });
    message = created.message;
    touchedConversation = created.conversation;
  } catch (error) {
    if (isUniqueConstraintViolation(error, "idempotencyKey")) {
      // §3.5 step 4: short-circuit with 200 OK, log-only — no second row written.
      log.info({ idempotencyKey, externalMessageId: normalized.externalMessageId }, "duplicate_webhook_ignored");
      const existing = await messageRepository.findByIdempotencyKey(organizationId, idempotencyKey);
      if (!existing) {
        // Should be unreachable (the constraint violation implies a row exists), but don't
        // swallow a genuinely unexpected state.
        throw error;
      }
      return { message: existing, conversation, contact: effectiveContact, wasDuplicate: true };
    }
    throw error;
  }

  // Step 6 (cont'd) + step 8: detect (if needed) and translate, outside any open
  // transaction (see the module doc comment for why). Any failure here is caught and
  // transitions the already-persisted row to FAILED instead of propagating — this is the
  // T1 fix's core behavior change.
  try {
    if (needsLanguageDetection) {
      const detection = await engine.detectLanguage(normalized.text);
      sourceLanguage = detection.language;
      effectiveContact = await contactRepository.updateDetectedLanguage(organizationId, effectiveContact.id, detection.language);
    }

    const translation = await engine.translate({
      organizationId,
      text: normalized.text,
      sourceLanguage,
      targetLanguage,
    });

    // Inbound messages are already delivered to us by definition — there is no separate
    // "sent" step, so a successful translation moves straight PENDING -> DELIVERED.
    assertValidTransition(message.status, "DELIVERED");
    const delivered = await messageRepository.updateTranslationResult(organizationId, message.id, {
      status: "DELIVERED",
      translatedText: translation.translatedText,
      sourceLanguage: translation.sourceLanguage,
      targetLanguage: translation.targetLanguage,
      translationProvider: translation.provider,
      translationConfidence: translation.confidence,
    });

    return { message: delivered, conversation: touchedConversation, contact: effectiveContact, wasDuplicate: false };
  } catch (error) {
    const failed = await handleInboundTranslationFailure(organizationId, message, error);
    return { message: failed, conversation: touchedConversation, contact: effectiveContact, wasDuplicate: false };
  }
}

/**
 * T1 fix: records a translation-step failure on an already-persisted inbound Message —
 * `FAILED` + a classified `failureReason` + a `translation_failed` MessageEvent, via the
 * same `transitionToFailed` helper the outbound lifecycle uses for both its send-failure and
 * translation-failure paths (see `outboundService.ts`'s `handleSendFailure`/
 * `handleTranslationFailure`). No automatic retry is scheduled here (unlike the outbound
 * translation-failure path) — see `retryInboundTranslation`'s doc comment for why inbound
 * translation retries are manual only.
 */
async function handleInboundTranslationFailure(organizationId: string, message: Message, error: unknown): Promise<Message> {
  const classification = classifyTranslationFailure(error);
  const failureReason = `Translation failed: ${error instanceof Error ? error.message : "Unknown translation failure"}`;
  return transitionToFailed(organizationId, message, "translation_failed", classification, failureReason);
}

/**
 * T1 fix: manual retry entrypoint for an inbound message that failed at the translation
 * step (`Message.status === "FAILED"`, `direction === "INBOUND"`) — re-attempts
 * `detectLanguage()`/`translate()` against the already-stored `originalText` and, on
 * success, transitions the row to `DELIVERED` exactly as a first-attempt success would.
 *
 * Deliberately MANUAL, not automatic via `retryQueue.runRetryWorkerOnce`:
 *   - That worker (wired up in `src/app/api/internal/retry-worker/route.ts`) drives
 *     `outboundService.retryMessage`, whose retry path resolves the conversation's channel
 *     adapter and calls `confirmAndSend` — there is no equivalent "adapter" step for an
 *     inbound message at all, so reusing that worker unmodified would try to *send* a
 *     received message back out through the channel, which is wrong.
 *   - `messageRepository.listFailedAwaitingRetry`/`listAllFailedAwaitingRetryAcrossOrgs` are
 *     therefore scoped to `direction: "OUTBOUND"`, so a FAILED inbound row can never reach
 *     that worker by accident in the first place.
 *   - Teaching the shared worker a second, adapter-less branch (direction-checked) was
 *     considered and rejected as more complex than a small, explicit, purpose-built
 *     function — a future manual "Retry translation" UI action (mirroring the outbound
 *     "Retry" button's `retryConversationMessage` Server Action) calls this directly with
 *     the message id; no polling/backoff is needed since a human decides when to retry.
 */
export async function retryInboundTranslation(
  organizationId: string,
  messageId: string,
  deps: ProcessInboundMessageDeps = {},
): Promise<Message> {
  const engine = deps.engine ?? translationEngine;
  const message = await messageRepository.findByIdInOrgOrThrow(organizationId, messageId);
  if (message.direction !== "INBOUND") {
    throw new ValidationError("retryInboundTranslation only applies to inbound messages.", {
      messageId,
      direction: message.direction,
    });
  }

  assertValidTransition(message.status, "PENDING");
  // Clear any stale `failureReason` from the previous attempt — a fresh retry attempt
  // shouldn't leave a misleading failure message on a row that goes on to succeed.
  const pending = await messageRepository.updateStatus(organizationId, messageId, "PENDING", { failureReason: null });

  const targetLanguage = pending.targetLanguage;
  if (!targetLanguage) {
    // Unreachable in practice — `processInboundMessage` always resolves and stores
    // `targetLanguage` before the first translation attempt — but fail loud rather than
    // silently calling the provider with an invalid input if this invariant is ever broken.
    throw new Error(`Message ${messageId} has no targetLanguage; cannot retry translation.`);
  }

  try {
    let sourceLanguage = pending.sourceLanguage ?? undefined;
    if (!sourceLanguage) {
      const detection = await engine.detectLanguage(pending.originalText);
      sourceLanguage = detection.language;
      const conversation = await conversationRepository.findByIdInOrgOrThrow(organizationId, pending.conversationId);
      await contactRepository.updateDetectedLanguage(organizationId, conversation.contactId, detection.language);
    }

    const translation = await engine.translate({
      organizationId,
      text: pending.originalText,
      sourceLanguage,
      targetLanguage,
    });

    assertValidTransition("PENDING", "DELIVERED");
    return messageRepository.updateTranslationResult(organizationId, messageId, {
      status: "DELIVERED",
      translatedText: translation.translatedText,
      sourceLanguage: translation.sourceLanguage,
      targetLanguage: translation.targetLanguage,
      translationProvider: translation.provider,
      translationConfidence: translation.confidence,
    });
  } catch (error) {
    return handleInboundTranslationFailure(organizationId, pending, error);
  }
}
