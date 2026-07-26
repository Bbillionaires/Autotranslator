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
 */
import type { Message, MessageStatus } from "@prisma/client";
import { isUniqueConstraintViolation } from "../db";
import { NotFoundError } from "../errors";
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
import { classifyAdapterFailure } from "./failureClassifier";
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

  // Step 3: translate.
  const translation = await engine.translate({ organizationId, text: params.text, targetLanguage });

  const idempotencyKey = deriveOutboundIdempotencyKey(params.clientIdempotencyKey);

  // Step 3 (cont'd): store as PENDING *before* any send attempt — this row is the durable
  // record even if the adapter call fails. Dedup'd via the idempotencyKey unique
  // constraint, same race-safe pattern as the inbound lifecycle: attempt the insert, catch
  // P2002, and treat a pre-existing row as "this call already happened" rather than erroring.
  let message: Message;
  try {
    message = await messageRepository.create({
      organizationId,
      conversationId,
      senderType: "USER",
      direction: "OUTBOUND",
      originalText: params.text,
      translatedText: translation.translatedText,
      sourceLanguage: translation.sourceLanguage,
      targetLanguage: translation.targetLanguage,
      translationProvider: translation.provider,
      translationConfidence: translation.confidence,
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

  assertValidTransition(message.status, "FAILED");
  let current = await messageRepository.updateStatus(organizationId, message.id, "FAILED", { failureReason });
  await messageEventRepository.create({
    messageId: message.id,
    eventType: "failed",
    payload: { classification, failureReason },
  });

  if (classification === "transient") {
    // May further transition FAILED -> DEAD_LETTER once the attempt cap is exceeded — if
    // so, `current` must reflect that, not the stale FAILED snapshot from just above.
    const deadLettered = await scheduleNextRetry(organizationId, message.id);
    if (deadLettered) {
      current = deadLettered;
    }
  }
  // Permanent failures stay FAILED (not auto-retried) but remain eligible for a manual
  // `retryMessage` call per the API route table (Server Action `retryMessage`: "only
  // allowed on terminal-failed states").

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
 * and by a manual "retry" UI action (a future Server Action) — both just need an
 * `organizationId` + `messageId` + resolved adapter.
 */
export async function retryMessage(organizationId: string, messageId: string, deps: OutboundServiceDeps): Promise<SendMessageResult> {
  const message = await messageRepository.findByIdInOrgOrThrow(organizationId, messageId);
  assertValidTransition(message.status, "PENDING");
  await messageRepository.updateStatus(organizationId, messageId, "PENDING");
  return confirmAndSend(organizationId, messageId, deps);
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
