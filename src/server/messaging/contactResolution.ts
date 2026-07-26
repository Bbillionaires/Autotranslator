/**
 * Resolve-or-create `Contact` + `ContactChannelIdentity` + canonical `Conversation` for a
 * given channel account and external contact id, per docs/implementation-plan.md §3.5 step
 * 5. Extracted out of `inboundService.ts` (Phase 5) so the Telegram bot-command flow (Phase
 * 6 — `/start`, `/language`, and callback-query language selection) can reuse the exact
 * same "find or create" resolution without duplicating repository-call sequencing, even
 * though bot commands never go through the full translate-and-store message pipeline.
 *
 * ## H5 fix — race-safe under concurrent first-contact delivery (docs/review-report.md)
 * Two near-simultaneous calls for the same brand-new `(channelAccountId, externalContactId)`
 * (e.g. a contact's first two messages arriving almost together, or an aggressive webhook
 * retry racing the original delivery) can both miss the `findByChannelAndExternalId` check
 * and both attempt to create a `Contact` + `ContactChannelIdentity`. `ContactChannelIdentity`
 * has `@@unique([channelAccountId, externalContactId])`, so the loser's insert throws a
 * Prisma P2002 inside the `$transaction`, rolling back that transaction's own `Contact`
 * insert too (Postgres transaction semantics — no orphaned Contact is left behind). Exactly
 * like `inboundService`/`outboundService` already do for the `Message` insert's
 * `idempotencyKey` unique constraint, we catch that specific P2002 here and re-fetch the
 * identity/contact the winning call created, instead of letting the error propagate as an
 * unhandled 500.
 */
import type { ChannelAccount, Contact, Conversation } from "@prisma/client";
import { isUniqueConstraintViolation, prisma } from "../db";
import { contactChannelIdentityRepository } from "../repositories/contactChannelIdentityRepository";
import { contactRepository } from "../repositories/contactRepository";
import { conversationRepository } from "../repositories/conversationRepository";

export interface ResolveContactParams {
  externalContactId: string;
  externalUsername?: string | null;
  phoneNumber?: string | null;
}

export interface ResolvedContact {
  contact: Contact;
  conversation: Conversation;
}

export async function resolveOrCreateContactAndConversation(
  organizationId: string,
  channelAccount: ChannelAccount,
  params: ResolveContactParams,
): Promise<ResolvedContact> {
  let contact: Contact;

  try {
    contact = await prisma.$transaction(async (tx) => {
      const identity = await contactChannelIdentityRepository.findByChannelAndExternalId(
        organizationId,
        channelAccount.id,
        params.externalContactId,
        tx,
      );

      if (identity) {
        return contactRepository.findByIdInOrgOrThrow(organizationId, identity.contactId, tx);
      }

      const created = await contactRepository.create(
        organizationId,
        {
          displayName: params.externalUsername ?? params.phoneNumber ?? params.externalContactId,
          phoneNumber: params.phoneNumber ?? null,
        },
        tx,
      );
      await contactChannelIdentityRepository.create(
        organizationId,
        {
          contactId: created.id,
          channelAccountId: channelAccount.id,
          externalContactId: params.externalContactId,
          externalUsername: params.externalUsername ?? null,
          phoneNumber: params.phoneNumber ?? null,
        },
        tx,
      );
      return created;
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error, "externalContactId")) {
      throw error;
    }
    // Lost the race: re-fetch the identity/contact the winning concurrent call created,
    // rather than erroring — mirrors the Message idempotencyKey pattern in
    // inboundService/outboundService.
    const identity = await contactChannelIdentityRepository.findByChannelAndExternalId(
      organizationId,
      channelAccount.id,
      params.externalContactId,
    );
    if (!identity) {
      // Should be unreachable (the constraint violation implies a row exists), but don't
      // swallow a genuinely unexpected state.
      throw error;
    }
    contact = await contactRepository.findByIdInOrgOrThrow(organizationId, identity.contactId);
  }

  // Same race, one step later: two concurrent calls that both resolved to the SAME
  // (newly-created-by-one-of-them) Contact can still both attempt to upsert the
  // `(contactId, channelAccountId)` Conversation at once. Empirically (see
  // contactResolution.test.ts's H5 concurrency test), Prisma's `upsert()` here is not
  // reliably atomic under genuine concurrent connections and can itself throw a P2002 on
  // the `@@unique([contactId, channelAccountId])` constraint — so this needs the exact same
  // catch-and-re-fetch treatment as the identity/contact race above, not just the
  // "upsert instead of find-then-create" mitigation `conversationRepository`'s own doc
  // comment describes.
  let conversation: Conversation;
  try {
    conversation = await conversationRepository.upsertForContactAndChannel(organizationId, contact.id, channelAccount.id);
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }
    const existing = await conversationRepository.findByContactAndChannelAccount(organizationId, contact.id, channelAccount.id);
    if (!existing) {
      throw error;
    }
    conversation = existing;
  }

  return { contact, conversation };
}
