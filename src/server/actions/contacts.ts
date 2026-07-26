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
import type { Contact } from "@prisma/client";
import { auth } from "../auth";
import { toSafeActionError } from "../errors";
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
