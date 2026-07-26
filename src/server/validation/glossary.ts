/**
 * Zod schemas for `TranslationGlossary` CRUD, per docs/implementation-plan.md §4/§5
 * ("Admin | Server Action `listGlossaries` / `createGlossary` / `updateGlossary` /
 * `deleteGlossary` | Glossary CRUD | Session+Role(Manager+) | Zod validates `terms` array
 * shape"). The Settings UI that calls these lands in Phase 7 — this module is the
 * validation layer the future Server Actions (and `glossaryRepository`) both depend on.
 */
import { z } from "zod";

/** A single glossary entry, matching the shape stored in `TranslationGlossary.terms`. */
export const glossaryTermSchema = z.object({
  term: z.string().min(1, "Term is required.").max(200),
  translation: z.string().min(1, "Translation is required.").max(200),
  notes: z.string().max(500).optional(),
});
export type GlossaryTerm = z.infer<typeof glossaryTermSchema>;

/** Loose BCP-47 validator — not exhaustive, just guards against empty/absurd input. */
const bcp47LanguageCode = z
  .string()
  .min(2, "Language code is required.")
  .max(35, "Language code is too long.");

export const createGlossarySchema = z.object({
  name: z.string().min(1, "Name is required.").max(200),
  sourceLanguage: bcp47LanguageCode,
  targetLanguage: bcp47LanguageCode,
  terms: z.array(glossaryTermSchema).min(1, "At least one glossary term is required."),
});
export type CreateGlossaryInput = z.infer<typeof createGlossarySchema>;

/** All fields optional for partial updates; `terms`, if supplied, still can't be empty. */
export const updateGlossarySchema = z.object({
  name: z.string().min(1, "Name is required.").max(200).optional(),
  sourceLanguage: bcp47LanguageCode.optional(),
  targetLanguage: bcp47LanguageCode.optional(),
  terms: z.array(glossaryTermSchema).min(1, "At least one glossary term is required.").optional(),
});
export type UpdateGlossaryInput = z.infer<typeof updateGlossarySchema>;
