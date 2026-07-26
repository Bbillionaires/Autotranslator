"use server";

/**
 * Org settings Server Actions, per docs/implementation-plan.md §5 ("Admin | Server Action
 * `getOrgSettings` / `updateOrgSettings` | Default language, timezone, translation provider
 * selection, review-before-send default, data retention window | Session+Role
 * (Administrator+) | audit-logged").
 *
 * Translation provider selection is env-driven (`TRANSLATION_PROVIDER`), per §2.3/§6.7 — it
 * is surfaced here as a read-only value, not something `updateOrgSettings` can change (the
 * plan documents this at env-validation time, not as a per-org DB setting).
 */
import { z } from "zod";
import type { Organization } from "@prisma/client";
import { auth } from "../auth";
import { env } from "../env";
import { toSafeActionError } from "../errors";
import { auditLogRepository } from "../repositories/auditLogRepository";
import { organizationRepository } from "../repositories/organizationRepository";
import { requireRole } from "../roles";

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

export interface OrgSettingsView extends Organization {
  translationProvider: string;
}

export async function getOrgSettings(): Promise<ActionResult<OrgSettingsView>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organization = await organizationRepository.findByIdOrThrow(session!.user.organizationId);
    return { ok: true, data: { ...organization, translationProvider: env.TRANSLATION_PROVIDER } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

/** Loose BCP-47 validator — matches the one used elsewhere in src/server/actions. */
const bcp47LanguageCode = z.string().min(2, "Language code is required.").max(35, "Language code is too long.");

const updateOrgSettingsSchema = z.object({
  defaultLanguage: bcp47LanguageCode.optional(),
  timezone: z.string().min(1).max(100).optional(),
  reviewBeforeSendDefault: z.boolean().optional(),
  dataRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
});
export type UpdateOrgSettingsInput = z.infer<typeof updateOrgSettingsSchema>;

export async function updateOrgSettings(input: UpdateOrgSettingsInput): Promise<ActionResult<OrgSettingsView>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const parsed = updateOrgSettingsSchema.parse(input);
    const organization = await organizationRepository.updateSettings(organizationId, parsed);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "organization.settings_updated",
      entityType: "Organization",
      entityId: organizationId,
      metadata: parsed,
    });

    return { ok: true, data: { ...organization, translationProvider: env.TRANSLATION_PROVIDER } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
