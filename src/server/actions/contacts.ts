"use server";

/**
 * Server Action `setContactLanguage`, per docs/implementation-plan.md §5 ("Contacts | Server
 * Action `setContactLanguage` | Set `preferredLanguage` explicitly | Session+Role(Agent+) |
 * Zod BCP-47 language code validator; audit-logged").
 *
 * `contactRepository.updatePreferredLanguage` already exists (built alongside the Phase 5
 * messaging core, since the outbound lifecycle needs to read `Contact.preferredLanguage`) —
 * this action is the missing Session+Role-guarded entry point an admin/agent UI calls to set
 * it directly, distinct from the Telegram `/language` self-service flow (Phase 6's webhook
 * route calls the repository directly on the contact's own behalf, not through this action).
 *
 * AuditLog note: §6.8 lists "contact archive" among audited mutations but doesn't list
 * `setContactLanguage` by name; full `AuditLog` row-writing across every sensitive mutation
 * is a Phase 10 (Review) cross-cutting pass. This action is a straightforward field update
 * with no channel/translation side effects, so it's left un-audited for now — flagged here
 * for Phase 10 rather than silently decided.
 */
import { z } from "zod";
import type { Contact, ContactChannelIdentity } from "@prisma/client";
import { auth } from "../auth";
import { toSafeActionError } from "../errors";
import { auditLogRepository } from "../repositories/auditLogRepository";
import { contactChannelIdentityRepository } from "../repositories/contactChannelIdentityRepository";
import { contactRepository } from "../repositories/contactRepository";
import { requireRole } from "../roles";

/** Loose BCP-47 validator — matches the one in src/server/validation/glossary.ts. */
const bcp47LanguageCode = z
  .string()
  .min(2, "Language code is required.")
  .max(35, "Language code is too long.");

const setContactLanguageSchema = z.object({
  contactId: z.string().min(1),
  preferredLanguage: bcp47LanguageCode,
});

export type SetContactLanguageInput = z.infer<typeof setContactLanguageSchema>;

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

export async function setContactLanguage(input: SetContactLanguageInput): Promise<ActionResult<Contact>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");

    const parsed = setContactLanguageSchema.parse(input);
    const contact = await contactRepository.updatePreferredLanguage(
      session!.user.organizationId,
      parsed.contactId,
      parsed.preferredLanguage,
    );
    return { ok: true, data: contact };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

/**
 * Server Action `createContact`, per §5 ("Create a contact | Session+Role(Agent+) | Zod:
 * displayName required; phone/email optional but ≥1 recommended").
 */
const createContactSchema = z.object({
  displayName: z.string().min(1, "Name is required.").max(200),
  phoneNumber: z.string().max(40).optional().nullable(),
  email: z.string().email().max(320).optional().nullable(),
  preferredLanguage: bcp47LanguageCode.optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});
export type CreateContactInput = z.infer<typeof createContactSchema>;

export async function createContact(input: CreateContactInput): Promise<ActionResult<Contact>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const parsed = createContactSchema.parse(input);
    const contact = await contactRepository.create(organizationId, {
      displayName: parsed.displayName,
      phoneNumber: parsed.phoneNumber || undefined,
      email: parsed.email || undefined,
      preferredLanguage: parsed.preferredLanguage || undefined,
      notes: parsed.notes || undefined,
    });
    return { ok: true, data: contact };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

/**
 * Server Action `updateContact`, per §5 ("Update fields (name, notes, etc.) |
 * Session+Role(Agent+) | partial Zod schema").
 */
const updateContactSchema = z.object({
  contactId: z.string().min(1),
  displayName: z.string().min(1).max(200).optional(),
  phoneNumber: z.string().max(40).nullable().optional(),
  email: z.string().email().max(320).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

export async function updateContact(input: UpdateContactInput): Promise<ActionResult<Contact>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "AGENT");
    const organizationId = session!.user.organizationId;

    const { contactId, ...rest } = updateContactSchema.parse(input);
    const contact = await contactRepository.update(organizationId, contactId, rest);
    return { ok: true, data: contact };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

/**
 * Server Action `archiveContact`, per §5 ("Soft-delete (set `archivedAt`) |
 * Session+Role(Manager+) | audit-logged").
 */
const archiveContactSchema = z.object({ contactId: z.string().min(1) });

export async function archiveContact(input: z.infer<typeof archiveContactSchema>): Promise<ActionResult<{ archived: true }>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "MANAGER");
    const organizationId = session!.user.organizationId;

    const parsed = archiveContactSchema.parse(input);
    await contactRepository.archive(organizationId, parsed.contactId);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "contact.archived",
      entityType: "Contact",
      entityId: parsed.contactId,
    });

    return { ok: true, data: { archived: true } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

/**
 * Server Action `connectChannelIdentity`, per §5 ("Link a `ContactChannelIdentity` to a
 * contact (merge duplicate identities) | Session+Role(Manager+)") — M4 fix
 * (docs/review-report.md). Used when two `Contact` records turn out to be the same human
 * across different first-contact events (e.g. a contact whose first message created a "new"
 * identity that should have matched an existing `Contact`): re-points the
 * `ContactChannelIdentity` at the target contact instead.
 *
 * Both the identity and the target contact are resolved via org-scoped
 * `findByIdInOrgOrThrow` lookups first, so a cross-org id for either one fails closed with
 * `NotFoundError` before any write is attempted. Already-linked (`identity.contactId ===
 * targetContactId`) is a no-op, not an error — and not audit-logged, since nothing actually
 * changed. Re-pointing `contactId` alone can never collide with
 * `@@unique([channelAccountId, externalContactId])` (verified: that constraint is keyed by
 * the identity's own channel account + external id, neither of which this touches).
 */
const connectChannelIdentitySchema = z.object({
  contactChannelIdentityId: z.string().min(1),
  contactId: z.string().min(1),
});
export type ConnectChannelIdentityInput = z.infer<typeof connectChannelIdentitySchema>;

export async function connectChannelIdentity(
  input: ConnectChannelIdentityInput,
): Promise<ActionResult<ContactChannelIdentity>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "MANAGER");
    const organizationId = session!.user.organizationId;

    const parsed = connectChannelIdentitySchema.parse(input);

    const identity = await contactChannelIdentityRepository.findByIdInOrgOrThrow(
      organizationId,
      parsed.contactChannelIdentityId,
    );
    // Org-scoped existence check on the target contact — throws NotFoundError for a
    // cross-org id, matching every other cross-entity Server Action in this file.
    await contactRepository.findByIdInOrgOrThrow(organizationId, parsed.contactId);

    if (identity.contactId === parsed.contactId) {
      // Already linked to this contact — a benign no-op, not an error.
      return { ok: true, data: identity };
    }

    const updated = await contactChannelIdentityRepository.reassignContact(
      organizationId,
      parsed.contactChannelIdentityId,
      parsed.contactId,
    );

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "contact_channel_identity.merged",
      entityType: "ContactChannelIdentity",
      entityId: parsed.contactChannelIdentityId,
      metadata: { fromContactId: identity.contactId, toContactId: parsed.contactId },
    });

    return { ok: true, data: updated };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
