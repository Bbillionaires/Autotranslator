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
 * long one: (1) resolve-or-create Contact + ContactChannelIdentity + Conversation (DB-only),
 * then the translation calls happen outside any transaction, then (2) create the Message +
 * "received" MessageEvent + bump `Conversation.lastMessageAt` together. Both transactions
 * are individually atomic; the "one Message row per idempotencyKey" guarantee (the actual
 * correctness requirement) is enforced by the unique-constraint catch around transaction
 * (2), which is race-safe regardless of how many transactions surround it.
 */
import type { ChannelAccount, Contact, Conversation, Message } from "@prisma/client";
import { isUniqueConstraintViolation, prisma } from "../db";
import { withContext } from "../logger";
import { organizationRepository } from "../repositories/organizationRepository";
import { contactChannelIdentityRepository } from "../repositories/contactChannelIdentityRepository";
import { contactRepository } from "../repositories/contactRepository";
import { conversationRepository } from "../repositories/conversationRepository";
import { messageEventRepository } from "../repositories/messageEventRepository";
import { messageRepository } from "../repositories/messageRepository";
import { userRepository } from "../repositories/userRepository";
import { TranslationEngine, translationEngine } from "../translation/engine";
import { resolveTargetLanguage } from "../translation/resolveLanguage";
import type { NormalizedInboundMessage } from "../channels/types";
import { deriveInboundIdempotencyKey } from "./idempotency";

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
  const { contact, conversation } = await prisma.$transaction(async (tx) => {
    const identity = await contactChannelIdentityRepository.findByChannelAndExternalId(
      organizationId,
      channelAccount.id,
      normalized.externalContactId,
      tx,
    );

    let resolvedContact: Contact;
    if (identity) {
      resolvedContact = await contactRepository.findByIdInOrgOrThrow(organizationId, identity.contactId, tx);
    } else {
      resolvedContact = await contactRepository.create(
        organizationId,
        {
          displayName: normalized.externalUsername ?? normalized.phoneNumber ?? normalized.externalContactId,
          phoneNumber: normalized.phoneNumber ?? null,
        },
        tx,
      );
      await contactChannelIdentityRepository.create(
        organizationId,
        {
          contactId: resolvedContact.id,
          channelAccountId: channelAccount.id,
          externalContactId: normalized.externalContactId,
          externalUsername: normalized.externalUsername ?? null,
          phoneNumber: normalized.phoneNumber ?? null,
        },
        tx,
      );
    }

    const resolvedConversation = await conversationRepository.upsertForContactAndChannel(
      organizationId,
      resolvedContact.id,
      channelAccount.id,
      tx,
    );

    return { contact: resolvedContact, conversation: resolvedConversation };
  });

  let effectiveContact = contact;

  // Step 6: detect sender language if Contact.preferredLanguage is not yet set.
  let sourceLanguage: string | undefined = effectiveContact.preferredLanguage ?? effectiveContact.detectedLanguage ?? undefined;
  if (!effectiveContact.preferredLanguage) {
    const detection = await engine.detectLanguage(normalized.text);
    sourceLanguage = detection.language;
    effectiveContact = await contactRepository.updateDetectedLanguage(organizationId, effectiveContact.id, detection.language);
  }

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

  // Step 8: translate.
  const translation = await engine.translate({
    organizationId,
    text: normalized.text,
    sourceLanguage,
    targetLanguage,
  });

  // Step 9: store Message + "received" MessageEvent + bump Conversation.lastMessageAt,
  // dedup'd via the idempotencyKey unique constraint (race-safe: we attempt the insert and
  // catch P2002, rather than checking existence first and then inserting).
  try {
    const { message, conversation: touchedConversation } = await prisma.$transaction(async (tx) => {
      const created = await messageRepository.create(
        {
          organizationId,
          conversationId: conversation.id,
          senderType: "CONTACT",
          direction: "INBOUND",
          originalText: normalized.text,
          translatedText: translation.translatedText,
          sourceLanguage: translation.sourceLanguage,
          targetLanguage: translation.targetLanguage,
          translationProvider: translation.provider,
          translationConfidence: translation.confidence,
          channelType: channelAccount.channelType,
          externalMessageId: normalized.externalMessageId,
          externalReplyToId: normalized.externalReplyToId ?? null,
          status: "DELIVERED", // inbound messages are already delivered to us by definition
          idempotencyKey,
        },
        tx,
      );

      await messageEventRepository.create(
        {
          messageId: created.id,
          eventType: "received",
          payload: (normalized.raw ?? null) as never,
        },
        tx,
      );

      const touchedConversation = await conversationRepository.touchLastMessageAt(
        organizationId,
        conversation.id,
        normalized.sentAt,
        tx,
      );

      return { message: created, conversation: touchedConversation };
    });

    return { message, conversation: touchedConversation, contact: effectiveContact, wasDuplicate: false };
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
}
