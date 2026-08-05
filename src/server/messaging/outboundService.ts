/**
 * Outbound message lifecycle, per docs/implementation-plan.md §3.6.
 *
 * `sendMessage` implements steps 1-5 (compose, resolve language, translate + store
 * PENDING, optional review-before-send gate, send via adapter); `confirmAndSend` is the
 * "actually call the adapter" step shared by a fresh compose (when review-before-send is
 * off) and a user confirming a previously-drafted translation. `retryMessage` (step 8/9)
 * is the single function both an automatic retry worker (`../messaging/retryQueue.ts`'s
 * `runRetryWorkerOnce`) and a manual "retry" UI action call — see the Definition of Done
 * note in the Phase 5 brief. `addInternalNote` is entirely separate: it never calls
 * `TranslationEngine` or a `MessagingChannelAdapter`.
 *
 * T1 fix (docs/test-report.md — "Translation-provider failures are not caught anywhere in
 * the message pipeline"): `sendMessage` already stored the `Message` row as `PENDING`
 * *before* any send attempt, per step 3 — this now ALSO covers the translation call itself:
 * the row is persisted with `originalText` and the already-resolved `targetLanguage` before
 * `engine.translate()` is ever called, and a thrown/rejected translation call is caught and
 * classified (`classifyTranslationFailure`, `./failureClassifier.ts`) exactly like an
 * adapter-send failure is (`handleSendFailure`) — see `handleTranslationFailure` below,
 * which shares `transitionToFailed` (`./failureTransition.ts`) and the same
 * transient-retry/dead-letter scheduling (`scheduleNextRetry`) with `handleSendFailure`, so
 * a translation failure is retried with the exact same backoff policy a send failure is.
 * `retryMessage` reuses this: if a `FAILED` message never got a `translatedText` (i.e. it
 * failed at the translation step, not the send step), retrying it re-attempts translation
 * first — never resends untranslated text — before ever touching the adapter.
 */
import type { Message, MessageStatus } from "@prisma/client";
import { isUniqueConstraintViolation } from "../db";
import { NotFoundError, ValidationError } from "../errors";
import { channelAccountRepository } from "../repositories/channelAccountRepository";
import { contactChannelIdentityRepository } from "../repositories/contactChannelIdentityRepository";
import { contactRepository } from "../repositories/contactRepository";
import { conversationRepository } from "../repositories/conversationRepository";
import { messageEventRepository } from "../repositories/messageEventRepository";
import { messageRepository } from "../repositories/messageRepository";
import { organizationRepository } from "../repositories/organizationRepository";
import { TranslationEngine, translationEngine } from "../translation/engine";
import { resolveTargetLanguage } from "../translation/resolveLanguage";
import type { MessagingChannelAdapter } from "../channels/types";
import { classifyAdapterFailure, classifyTranslationFailure, type FailureClassification } from "./failureClassifier";
import { transitionToFailed } from "./failureTransition";
import { deriveOutboundIdempotencyKey } from "./idempotency";
import { assertValidTransition, countScheduledRetryAttempts, nextRetryDecision } from "./retryQueue";

export interface OutboundServiceDeps {
  /** The channel adapter to send through — resolved by the caller (route/action) via `channelAdapterRegistry`, or a `FakeChannelAdapter` in tests. */
  adapter: MessagingChannelAdapter;
  /** Override for tests. Defaults to the process-wide `translationEngine`. */
  engine?: TranslationEngine;
}

export interface SendMessageParams {
  organizationId: string;
  conversationId: string;
  text: string;
  /** Client-generated idempotency key from the compose form; a UUID is generated server-side if omitted. */
  clientIdempotencyKey?: string | null;
  /** When true, stops after storing the PENDING translated draft and returns it for confirmation instead of sending. */
  reviewBeforeSend?: boolean;
}

/**
 * "QUEUED" (Phase 8) is distinct from "DRAFT": a `QUEUED` message has already been sent to
 * (accepted by) its channel adapter and is durably out of the compose form's hands — it's
 * just not yet confirmed delivered by the underlying channel (the Android gateway's
 * inverted control flow — see `confirmAndSend` below). A `DRAFT` message, by contrast,
 * hasn't been sent anywhere yet (review-before-send gate).
 */
export type SendMessageOutcome = "DRAFT" | "QUEUED" | "SENT" | "FAILED";

export interface SendMessageResult {
  message: Message;
  outcome: SendMessageOutcome;
}

function outcomeFromStatus(status: MessageStatus): SendMessageOutcome {
  if (status === "SENT" || status === "DELIVERED" || status === "READ") return "SENT";
  if (status === "FAILED" || status === "DEAD_LETTER") return "FAILED";
  if (status === "QUEUED") return "QUEUED";
  return "DRAFT";
}

/**
 * §3.6 steps 1-5: compose, resolve the recipient's language, translate, store as PENDING
 * *before* any send attempt, then either stop for review or send immediately.
 */
export async function sendMessage(params: SendMessageParams, deps: OutboundServiceDeps): Promise<SendMessageResult> {
  const engine = deps.engine ?? translationEngine;
  const { organizationId, conversationId } = params;

  const conversation = await conversationRepository.findByIdInOrgOrThrow(organizationId, conversationId);
  const contact = await contactRepository.findByIdInOrgOrThrow(organizationId, conversation.contactId);
  const channelAccount = await channelAccountRepository.findByIdInOrgOrThrow(organizationId, conversation.channelAccountId);
  const organization = await organizationRepository.findByIdOrThrow(organizationId);

  // Step 2: resolve recipient's language (§3.4 chain: conversation override -> contact
  // preferred -> contact detected -> org default -> "en").
  const targetLanguage = resolveTargetLanguage({
    conversationOverride: conversation.preferredLanguageOverride,
    contactPreferred: contact.preferredLanguage,
    contactDetected: contact.detectedLanguage,
    orgDefault: organization.defaultLanguage,
  });

  const idempotencyKey = deriveOutboundIdempotencyKey(params.clientIdempotencyKey);

  // Step 3 (T1 fix — reordered): store as PENDING *before* any send attempt AND before any
  // translation attempt — `originalText` plus the already-resolved `targetLanguage` (both
  // DB-only, no external call) are the durable record even if `engine.translate()` throws.
  // Dedup'd via the idempotencyKey unique constraint, same race-safe pattern as the inbound
  // lifecycle: attempt the insert, catch P2002, and treat a pre-existing row as "this call
  // already happened" rather than erroring (and, notably, without re-attempting translation
  // for it — a double-submit of an already-failed compose is surfaced as-is, not silently
  // retried).
  let message: Message;
  try {
    message = await messageRepository.create({
      organizationId,
      conversationId,
      senderType: "USER",
      direction: "OUTBOUND",
      originalText: params.text,
      targetLanguage,
      channelType: channelAccount.channelType,
      status: "PENDING",
      idempotencyKey,
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error, "idempotencyKey")) {
      const existing = await messageRepository.findByIdempotencyKey(organizationId, idempotencyKey);
      if (existing) {
        return { message: existing, outcome: outcomeFromStatus(existing.status) };
      }
    }
    throw error;
  }

  // Step 3 (cont'd): translate, now that the row is durably stored. A thrown/rejected call
  // here no longer loses the message — it's caught and classified the same way an adapter
  // failure is (see `handleTranslationFailure`).
  let translation;
  try {
    translation = await engine.translate({ organizationId, text: params.text, targetLanguage });
  } catch (error) {
    return handleTranslationFailure(organizationId, message, error);
  }

  message = await messageRepository.updateTranslationResult(organizationId, message.id, {
    status: "PENDING",
    translatedText: translation.translatedText,
    sourceLanguage: translation.sourceLanguage,
    targetLanguage: translation.targetLanguage,
    translationProvider: translation.provider,
    translationConfidence: translation.confidence,
  });

  // Step 4: review-before-send gate — return the draft instead of sending immediately.
  if (params.reviewBeforeSend) {
    return { message, outcome: "DRAFT" };
  }

  // Step 5: send via adapter.
  return confirmAndSend(organizationId, message.id, deps);
}

/**
 * §3.6 step 5 (the actual adapter call) through step 7 (persist external id, record the
 * `sent` MessageEvent) — or, on failure, classify + record + optionally schedule a retry.
 * Called both by `sendMessage` (when review-before-send is off) and by whatever Server
 * Action confirms a previously-drafted (PENDING, review-before-send) message.
 */
export async function confirmAndSend(
  organizationId: string,
  messageId: string,
  deps: OutboundServiceDeps,
): Promise<SendMessageResult> {
  const message = await messageRepository.findByIdInOrgOrThrow(organizationId, messageId);
  const conversation = await conversationRepository.findByIdInOrgOrThrow(organizationId, message.conversationId);
  const channelAccount = await channelAccountRepository.findByIdInOrgOrThrow(organizationId, conversation.channelAccountId);
  const identity = await contactChannelIdentityRepository.findByContactAndChannelAccount(
    organizationId,
    conversation.contactId,
    channelAccount.id,
  );
  if (!identity) {
    throw new NotFoundError("No channel identity found to send this message to.", {
      organizationId,
      conversationId: conversation.id,
      channelAccountId: channelAccount.id,
    });
  }

  let sendResult;
  try {
    sendResult = await deps.adapter.sendMessage({
      channelAccount,
      externalContactId: identity.externalContactId,
      text: message.translatedText ?? message.originalText,
      replyToExternalId: message.externalReplyToId ?? undefined,
    });
  } catch (error) {
    return handleSendFailure(organizationId, message, error);
  }

  // The message is only ever marked SENT/QUEUED after the adapter call *returns success* —
  // never optimistically. Per §3.2's `SendMessageResult.status: "SENT" | "QUEUED"`, most
  // adapters (Telegram, WhatsApp) always return "SENT" here (their `sendMessage` really did
  // call the upstream API synchronously) and this is functionally identical to Phase 5/6's
  // original "always SENT" behavior for them. `AndroidSmsAdapter` (Phase 8) is the one
  // adapter that returns "QUEUED": its inverted control flow means the row is only queued
  // for device pickup at this point, not actually sent — the real `SENT` transition happens
  // later, when the device calls `POST /api/gateways/messages/:id/acknowledge`
  // (`acknowledgeMessage` below reuses `assertValidTransition`/`messageEventRepository` the
  // exact same way this function does).
  assertValidTransition(message.status, sendResult.status);
  const updated = await messageRepository.updateStatus(organizationId, messageId, sendResult.status, {
    externalMessageId: sendResult.externalMessageId,
  });
  await messageEventRepository.create({
    messageId,
    eventType: sendResult.status === "SENT" ? "sent" : "queued_for_pickup",
    externalEventId: sendResult.externalMessageId,
    payload: { adapterStatus: sendResult.status },
  });

  return { message: updated, outcome: outcomeFromStatus(updated.status) };
}

/**
 * Classifies + records a send failure and, for transient failures, schedules the next
 * automatic retry (moving to `DEAD_LETTER` once the attempt cap is exceeded). Exported (not
 * just used internally by `confirmAndSend`'s catch block) so the Android gateway's
 * `POST /api/gateways/messages/:id/fail` route can report a *device-observed* send failure
 * (the device's own carrier/SIM error, not a thrown adapter exception) through the exact
 * same classification + retry-scheduling + `MessageEvent` logic, by constructing an
 * `UpstreamAdapterError` with an explicit `detail.transient` hint (see
 * `src/server/gateways/androidFailureReasons.ts`) and passing it here — no duplicated retry
 * logic between the two entry points.
 */
export async function handleSendFailure(organizationId: string, message: Message, error: unknown): Promise<SendMessageResult> {
  const classification = classifyAdapterFailure(error);
  const failureReason = error instanceof Error ? error.message : "Unknown adapter failure";
  return finalizeFailure(organizationId, message, "failed", classification, failureReason);
}

/**
 * T1 fix (docs/test-report.md): the translation-step counterpart of `handleSendFailure`
 * above, called when `engine.translate()` throws — either during `sendMessage`'s initial
 * compose or during `retryMessage`'s re-attempt for a message that previously failed at
 * this same step. Shares `finalizeFailure` (assert-transition + persist `FAILED` +
 * classified `MessageEvent` + transient-retry/dead-letter scheduling) with
 * `handleSendFailure` so a translation failure is retried with the exact same backoff
 * policy a send failure already was — no separate retry/backoff machinery was invented for
 * this. `eventType: "translation_failed"` (distinct from `"failed"`) is the only thing that
 * differs, so a message's event history makes clear which step actually failed.
 */
export async function handleTranslationFailure(organizationId: string, message: Message, error: unknown): Promise<SendMessageResult> {
  const classification = classifyTranslationFailure(error);
  const failureReason = `Translation failed: ${error instanceof Error ? error.message : "Unknown translation failure"}`;
  return finalizeFailure(organizationId, message, "translation_failed", classification, failureReason);
}

/**
 * Shared tail of both failure handlers above: persist `FAILED` + the classified
 * `failureReason` via `transitionToFailed` (`./failureTransition.ts`, shared with the
 * inbound lifecycle's own translation-failure handling), then — for a transient
 * classification only — schedule the next automatic retry (which may itself further
 * transition `FAILED -> DEAD_LETTER` once the attempt cap is exceeded; `current` is updated
 * to reflect that rather than the stale `FAILED` snapshot). Permanent failures stay `FAILED`
 * (not auto-retried) but remain eligible for a manual `retryMessage` call per the API route
 * table (Server Action `retryMessage`: "only allowed on terminal-failed states").
 */
async function finalizeFailure(
  organizationId: string,
  message: Message,
  eventType: "failed" | "translation_failed",
  classification: FailureClassification,
  failureReason: string,
): Promise<SendMessageResult> {
  let current = await transitionToFailed(organizationId, message, eventType, classification, failureReason);

  if (classification === "transient") {
    const deadLettered = await scheduleNextRetry(organizationId, message.id);
    if (deadLettered) {
      current = deadLettered;
    }
  }

  return { message: current, outcome: outcomeFromStatus(current.status) };
}

/**
 * Schedules the next automatic retry, or moves the message to DEAD_LETTER once the attempt
 * cap is exceeded. Returns the updated `Message` when it moved to `DEAD_LETTER` (so the
 * caller's in-memory snapshot doesn't go stale), or `null` when it merely scheduled another
 * retry and the message is still `FAILED`.
 */
async function scheduleNextRetry(organizationId: string, messageId: string): Promise<Message | null> {
  const events = await messageEventRepository.listByMessage(organizationId, messageId);
  const previousAttempts = countScheduledRetryAttempts(events);
  const decision = nextRetryDecision(previousAttempts);

  if (decision.status === "DEAD_LETTER") {
    assertValidTransition("FAILED", "DEAD_LETTER");
    const deadLettered = await messageRepository.updateStatus(organizationId, messageId, "DEAD_LETTER", {
      failureReason: `Retry attempt cap (${previousAttempts}) exceeded.`,
    });
    await messageEventRepository.create({
      messageId,
      eventType: "dead_letter",
      payload: { attempts: previousAttempts },
    });
    return deadLettered;
  }

  const scheduledFor = new Date(Date.now() + decision.delayMs);
  await messageEventRepository.create({
    messageId,
    eventType: "retry_scheduled",
    payload: { attempt: decision.attempt, scheduledFor: scheduledFor.toISOString() },
  });
  return null;
}

/**
 * Re-attempts sending a `FAILED`/`DEAD_LETTER` message. Usable both by the automatic retry
 * worker (`retryQueue.ts`'s `runRetryWorkerOnce`, injected as its `retryMessage` dependency)
 * and by a manual "retry" UI action (`retryConversationMessage`) — both just need an
 * `organizationId` + `messageId` + resolved adapter. Outbound-only: an inbound message that
 * failed at the translation step is retried via `inboundService.retryInboundTranslation`
 * instead (no adapter/send step applies to it at all).
 *
 * T1 fix (docs/test-report.md): a message can now be `FAILED` because translation itself
 * failed (`translatedText` still `null`), not just because the adapter send failed
 * (`translatedText` populated). Retrying the former must re-attempt translation FIRST —
 * `confirmAndSend` would otherwise happily "send" `message.translatedText ?? message.originalText`,
 * i.e. the raw untranslated text, straight to the channel. `translatedText === null` is
 * exactly the signal that distinguishes the two cases, since a successful translation
 * always populates it before the message can ever reach the send step.
 */
export async function retryMessage(organizationId: string, messageId: string, deps: OutboundServiceDeps): Promise<SendMessageResult> {
  const message = await messageRepository.findByIdInOrgOrThrow(organizationId, messageId);
  if (message.direction !== "OUTBOUND") {
    throw new ValidationError("retryMessage only applies to outbound messages.", {
      messageId,
      direction: message.direction,
    });
  }

  assertValidTransition(message.status, "PENDING");
  // Clear any stale `failureReason` from the previous attempt — a fresh retry attempt
  // shouldn't leave a misleading failure message on a row that goes on to succeed.
  const pending = await messageRepository.updateStatus(organizationId, messageId, "PENDING", { failureReason: null });

  if (pending.translatedText === null) {
    return retryTranslationThenSend(organizationId, pending, deps);
  }

  return confirmAndSend(organizationId, messageId, deps);
}

/** Re-attempts translation for a message that previously failed at that step, then proceeds to `confirmAndSend` on success. */
async function retryTranslationThenSend(organizationId: string, message: Message, deps: OutboundServiceDeps): Promise<SendMessageResult> {
  const engine = deps.engine ?? translationEngine;

  const targetLanguage = message.targetLanguage;
  if (!targetLanguage) {
    // Unreachable in practice — `sendMessage` always resolves and stores `targetLanguage`
    // before the first translation attempt — but fail loud rather than silently calling the
    // provider with an invalid input if this invariant is ever broken.
    throw new Error(`Message ${message.id} has no targetLanguage; cannot retry translation.`);
  }

  let translation;
  try {
    translation = await engine.translate({ organizationId, text: message.originalText, targetLanguage });
  } catch (error) {
    return handleTranslationFailure(organizationId, message, error);
  }

  const updated = await messageRepository.updateTranslationResult(organizationId, message.id, {
    status: "PENDING",
    translatedText: translation.translatedText,
    sourceLanguage: translation.sourceLanguage,
    targetLanguage: translation.targetLanguage,
    translationProvider: translation.provider,
    translationConfidence: translation.confidence,
  });

  return confirmAndSend(organizationId, updated.id, deps);
}

/**
 * Adds an internal note to a conversation — a `Message` with `isInternalNote: true` that
 * is never translated and never sent through a channel adapter. `channelType` is still set
 * (the schema requires it) to the conversation's own channel, purely for record
 * association; it does not mean the note was sent over that channel.
 */
export async function addInternalNote(organizationId: string, conversationId: string, senderUserId: string, text: string): Promise<Message> {
  const conversation = await conversationRepository.findByIdInOrgOrThrow(organizationId, conversationId);
  const channelAccount = await channelAccountRepository.findByIdInOrgOrThrow(organizationId, conversation.channelAccountId);

  const message = await messageRepository.create({
    organizationId,
    conversationId,
    senderType: "USER",
    direction: "OUTBOUND",
    originalText: text,
    channelType: channelAccount.channelType,
    status: "DELIVERED",
    idempotencyKey: deriveOutboundIdempotencyKey(),
    isInternalNote: true,
  });

  await messageEventRepository.create({
    messageId: message.id,
    eventType: "internal_note_added",
    payload: { senderUserId },
  });

  return message;
}
