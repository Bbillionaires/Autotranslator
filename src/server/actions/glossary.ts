"use server";

/**
 * Glossary CRUD Server Actions, per docs/implementation-plan.md §5 ("Admin | Server Action
 * `listGlossaries` / `createGlossary` / `updateGlossary` / `deleteGlossary` | Glossary CRUD
 * | Session+Role(Manager+) | Zod validates `terms` array shape").
 *
 * `glossaryRepository` and its Zod schemas (`../validation/glossary.ts`) already existed
 * from Phase 4 (built ahead of the Settings UI that would call them, per that repository's
 * doc comment) — this file is the missing Session+Role-guarded entry point.
 */
import { auth } from "../auth";
import { toSafeActionError } from "../errors";
import { auditLogRepository } from "../repositories/auditLogRepository";
import { glossaryRepository, type TranslationGlossaryRecord } from "../repositories/glossaryRepository";
import { createGlossarySchema, updateGlossarySchema, type CreateGlossaryInput, type UpdateGlossaryInput } from "../validation/glossary";
import { requireRole } from "../roles";

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

export async function listGlossaries(): Promise<ActionResult<TranslationGlossaryRecord[]>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "MANAGER");
    const glossaries = await glossaryRepository.list(session!.user.organizationId);
    return { ok: true, data: glossaries };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

export async function createGlossary(input: CreateGlossaryInput): Promise<ActionResult<TranslationGlossaryRecord>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "MANAGER");
    const organizationId = session!.user.organizationId;

    const parsed = createGlossarySchema.parse(input);
    const glossary = await glossaryRepository.create(organizationId, parsed);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "glossary.created",
      entityType: "TranslationGlossary",
      entityId: glossary.id,
      metadata: { name: glossary.name, sourceLanguage: glossary.sourceLanguage, targetLanguage: glossary.targetLanguage },
    });

    return { ok: true, data: glossary };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

export async function updateGlossary(
  input: { id: string } & UpdateGlossaryInput,
): Promise<ActionResult<TranslationGlossaryRecord>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "MANAGER");
    const organizationId = session!.user.organizationId;

    const { id, ...rest } = input;
    const parsed = updateGlossarySchema.parse(rest);
    const glossary = await glossaryRepository.update(organizationId, id, parsed);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "glossary.updated",
      entityType: "TranslationGlossary",
      entityId: id,
      metadata: parsed,
    });

    return { ok: true, data: glossary };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

export async function deleteGlossary(input: { id: string }): Promise<ActionResult<{ deleted: true }>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "MANAGER");
    const organizationId = session!.user.organizationId;

    await glossaryRepository.delete(organizationId, input.id);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "glossary.deleted",
      entityType: "TranslationGlossary",
      entityId: input.id,
    });

    return { ok: true, data: { deleted: true } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
