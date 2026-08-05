"use server";

/**
 * Server Action `sendMessage` (named `sendConversationMessage` here to avoid clashing with
 * `../messaging/outboundService`'s `sendMessage`), per docs/implementation-plan.md §5
 * ("Messages | Server Action `sendMessage` | Compose + translate + send outbound |
 * Session+Role(Agent+) | Zod: text non-empty, idempotencyKey uuid; runs full outbound
 * lifecycle (§3.6)").
 *
 * This is the missing "compose path" glue the Phase 6 task brief asked to verify/add:
 * `outboundService.sendMessage` (Phase 5) already implements the full §3.6 lifecycle but
 * takes a resolved `MessagingChannelAdapter` as an explicit dependency rather than looking
 * one up itself (by design — keeps the service layer adapter-agnostic and unit-testable
 * with `FakeChannelAdapter`). This action is the thin, auth-guarded, org-scoped wrapper that
 * resolves the conversation's channel and its registered adapter (Telegram today; whatever
 * Phase 8/9 register later) via `channelAdapterRegistry`, then delegates — so a Telegram
 * conversation's outbound reply is translated into the contact's language and actually
 * delivered end-to-end via `TelegramAdapter.sendMessage`.
 *
 * `retryConversationMessage` is the Server Action counterpart of §5's "Server Action
 * `retryMessage`" row, wrapping `outboundService.retryMessage` the same way.
 */
import { z } from "zod";
import type { Message } from "@prisma/client";
import { auth } from "../auth";
import { channelAdapterRegistry } from "../channels";
import { toSafeActionError, ValidationError } from "../errors";
import { retryInboundTranslation } from "../messaging/inboundService";
import { confirmAndSend, sendMessage, retryMessage as retryOutboundMessage, type SendMessageResult } from "../messaging/outboundService";
import { auditLogRepository } from "../repositories/auditLogRepository";
import { channelAccountRepository } from "../repositories/channelAccountRepository";
import { conversationRepository } from "../repositories/conversationRepository";
import { messageRepository } from "../repositories/messageRepository";
import { requireRole } from "../roles";

const sendConversationMessageSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1, "Message text is required."),
  clientIdempotencyKey: z.string().uuid().optional(),
  reviewBeforeSend: z.boolean().optional(),
});

export type SendConversationMessageInput = z.infer<typeof sendConversationMessageSchema>;

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

/** Resolves the registered adapter for a conversation's channel, org-scoped throughout. */
async function resolveAdapterForConversation(organizationId: string, conversationId: string) {
  const conversation = await conversationRepository.findByIdInOrgOrThrow(organizationId, conversationId);
  const channelAccount = await channelAccountRepository.findByIdInOrgOrThrow(organizationId, conversation.channelAccountId);
  const adapter = channelAdapterRegistry.getOrThrow(channelAccount.channelType);
  return { conversation, channelAccount, adapter };
}

/** Resolves the registered adapter for whichever conversation a given message belongs to. */
async function resolveAdapterForMessage(organizationId: string, messageId: string) {
  const message = await messageRepository.findByIdInOrgOrThrow(organizationId, messageId);
  return resolveAdapterForConversation(organizationId, message.conversationId);
}

export async function sendConversationMessage(input: SendConversationMessageInput): Promise<ActionResult<SendMessageResult>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const parsed = sendConversationMessageSchema.parse(input);
    const { adapter } = await resolveAdapterForConversation(organizationId, parsed.conversationId);

    const result = await sendMessage(
      {
        organizationId,
        conversationId: parsed.conversationId,
        text: parsed.text,
        clientIdempotencyKey: parsed.clientIdempotencyKey,
        reviewBeforeSend: parsed.reviewBeforeSend,
      },
      { adapter },
    );
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

/** Confirms a previously-drafted (review-before-send) message — Server Action wrapper around `confirmAndSend`. */
export async function confirmAndSendConversationMessage(input: { messageId: string }): Promise<ActionResult<SendMessageResult>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const { adapter } = await resolveAdapterForMessage(organizationId, input.messageId);
    const result = await confirmAndSend(organizationId, input.messageId, { adapter });
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

/** Server Action `retryMessage`, per §5 ("only allowed on terminal-failed states"). */
export async function retryConversationMessage(input: { messageId: string }): Promise<ActionResult<SendMessageResult>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const { adapter } = await resolveAdapterForMessage(organizationId, input.messageId);
    const result = await retryOutboundMessage(organizationId, input.messageId, { adapter });
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

/**
 * T1 fix (docs/test-report.md): manual retry entrypoint for an INBOUND message that failed
 * at the translation step — the counterpart of `retryConversationMessage` above, but for
 * `inboundService.retryInboundTranslation` instead of `outboundService.retryMessage` (see
 * that function's doc comment for why inbound translation retries are manual, not picked up
 * by the automatic retry worker). No adapter resolution needed — there is no send step.
 */
export async function retryInboundMessageTranslation(input: { messageId: string }): Promise<ActionResult<Message>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const result = await retryInboundTranslation(organizationId, input.messageId);
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const recordTranslationEditSchema = z.object({
  messageId: z.string().min(1),
  translatedText: z.string().min(1, "Translated text is required."),
});

/**
 * Server Action `recordTranslationEdit`, per §5 ("Persist a user edit to `translatedText`
 * pre-send | Session+Role(Agent+) | sets `translationEdited: true`; audit-logged"). Used by
 * the review-before-send draft view (Phase 7) when a user edits the machine translation
 * before confirming send — an explicit, audit-logged edit, never a silent overwrite.
 */
export async function recordTranslationEdit(
  input: z.infer<typeof recordTranslationEditSchema>,
): Promise<ActionResult<Message>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const parsed = recordTranslationEditSchema.parse(input);
    const existing = await messageRepository.findByIdInOrgOrThrow(organizationId, parsed.messageId);
    if (existing.status !== "PENDING") {
      throw new ValidationError("Only a pending (not-yet-sent) draft's translation can be edited.");
    }

    const updated = await messageRepository.markTranslationEdited(organizationId, parsed.messageId, parsed.translatedText);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "message.translation_edited",
      entityType: "Message",
      entityId: parsed.messageId,
    });

    return { ok: true, data: updated };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
