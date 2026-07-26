/**
 * Org-scoped repository for `TranslationGlossary`, per docs/implementation-plan.md §6.1
 * (repository pattern established in `organizationRepository.ts`/`userRepository.ts`) and
 * the Phase 4 task brief. Every function takes the caller's `organizationId` explicitly
 * and re-asserts it in the `where` clause on every read/write/delete — no bare
 * `prisma.translationGlossary.*` call reachable from a route bypasses this.
 *
 * `findApplicableTerms` is the one method consumed outside the admin CRUD surface: it's
 * what `TranslationEngine` (../translation/engine.ts) calls to merge glossary terms into
 * a `translate()` call for a given org + source/target language pair.
 */
import { prisma } from "../db";
import { NotFoundError } from "../errors";
import type { CreateGlossaryInput, GlossaryTerm, UpdateGlossaryInput } from "../validation/glossary";

export interface TranslationGlossaryRecord {
  id: string;
  organizationId: string;
  name: string;
  sourceLanguage: string;
  targetLanguage: string;
  terms: GlossaryTerm[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `terms` is stored as Prisma `Json`. Writes always go through `createGlossarySchema`/
 * `updateGlossarySchema`, but this defensively re-validates on read too — cheap insurance
 * against a row written by some future direct-SQL migration or manual edit.
 */
function parseTerms(raw: unknown): GlossaryTerm[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is GlossaryTerm => {
    return (
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).term === "string" &&
      typeof (item as Record<string, unknown>).translation === "string"
    );
  });
}

function toRecord(row: {
  id: string;
  organizationId: string;
  name: string;
  sourceLanguage: string;
  targetLanguage: string;
  terms: unknown;
  createdAt: Date;
  updatedAt: Date;
}): TranslationGlossaryRecord {
  return { ...row, terms: parseTerms(row.terms) };
}

export const glossaryRepository = {
  async list(organizationId: string): Promise<TranslationGlossaryRecord[]> {
    const rows = await prisma.translationGlossary.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
    });
    return rows.map(toRecord);
  },

  async findByIdOrThrow(organizationId: string, id: string): Promise<TranslationGlossaryRecord> {
    const row = await prisma.translationGlossary.findFirst({ where: { id, organizationId } });
    if (!row) {
      throw new NotFoundError("Glossary not found.", { organizationId, id });
    }
    return toRecord(row);
  },

  async create(
    organizationId: string,
    input: CreateGlossaryInput,
  ): Promise<TranslationGlossaryRecord> {
    const row = await prisma.translationGlossary.create({
      data: {
        organizationId,
        name: input.name,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        terms: input.terms,
      },
    });
    return toRecord(row);
  },

  async update(
    organizationId: string,
    id: string,
    input: UpdateGlossaryInput,
  ): Promise<TranslationGlossaryRecord> {
    // Re-assert organizationId in the where clause (updateMany, not update) so this can
    // never modify another org's glossary even if `id` were guessed/forged.
    const result = await prisma.translationGlossary.updateMany({
      where: { id, organizationId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.sourceLanguage !== undefined ? { sourceLanguage: input.sourceLanguage } : {}),
        ...(input.targetLanguage !== undefined ? { targetLanguage: input.targetLanguage } : {}),
        ...(input.terms !== undefined ? { terms: input.terms } : {}),
      },
    });
    if (result.count === 0) {
      throw new NotFoundError("Glossary not found.", { organizationId, id });
    }
    return glossaryRepository.findByIdOrThrow(organizationId, id);
  },

  async delete(organizationId: string, id: string): Promise<void> {
    const result = await prisma.translationGlossary.deleteMany({ where: { id, organizationId } });
    if (result.count === 0) {
      throw new NotFoundError("Glossary not found.", { organizationId, id });
    }
  },

  /**
   * Flattened, merged glossary terms applicable to a specific org + source→target
   * language pair. Used by `TranslationEngine` to build `TranslateInput.glossary` before
   * calling the active provider — never called directly from a route/action.
   */
  async findApplicableTerms(
    organizationId: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<GlossaryTerm[]> {
    const rows = await prisma.translationGlossary.findMany({
      where: { organizationId, sourceLanguage, targetLanguage },
    });
    return rows.flatMap((row) => parseTerms(row.terms));
  },
};
