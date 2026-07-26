/**
 * Resolve-or-create `Contact` + `ContactChannelIdentity` + canonical `Conversation` for a
 * given channel account and external contact id, per docs/implementation-plan.md §3.5 step
 * 5. Extracted out of `inboundService.ts` (Phase 5) so the Telegram bot-command flow (Phase
 * 6 — `/start`, `/language`, and callback-query language selection) can reuse the exact
 * same "find or create" resolution without duplicating repository-call sequencing, even
 * though bot commands never go through the full translate-and-store message pipeline.
 */
import type { ChannelAccount, Contact, Conversation } from "@prisma/client";
import { prisma } from "../db";
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
  return prisma.$transaction(async (tx) => {
    const identity = await contactChannelIdentityRepository.findByChannelAndExternalId(
      organizationId,
      channelAccount.id,
      params.externalContactId,
      tx,
    );

    let contact: Contact;
    if (identity) {
      contact = await contactRepository.findByIdInOrgOrThrow(organizationId, identity.contactId, tx);
    } else {
      contact = await contactRepository.create(
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
          contactId: contact.id,
          channelAccountId: channelAccount.id,
          externalContactId: params.externalContactId,
          externalUsername: params.externalUsername ?? null,
          phoneNumber: params.phoneNumber ?? null,
        },
        tx,
      );
    }

    const conversation = await conversationRepository.upsertForContactAndChannel(
      organizationId,
      contact.id,
      channelAccount.id,
      tx,
    );

    return { contact, conversation };
  });
}
