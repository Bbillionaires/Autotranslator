/**
 * A short, human-friendly list of common BCP-47 language codes for `<select>` inputs
 * (contact preferred language, conversation language override, org default language,
 * glossary source/target language). Not exhaustive — any freeform code is still accepted by
 * the underlying Zod validators (`src/server/validation/glossary.ts`,
 * `src/server/actions/contacts.ts`); this list just gives the common cases a dropdown
 * instead of forcing free text everywhere.
 */
export const COMMON_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "pl", label: "Polish" },
  { code: "nl", label: "Dutch" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "hi", label: "Hindi" },
  { code: "tr", label: "Turkish" },
];

export function languageLabel(code: string | null | undefined): string {
  if (!code) return "Unknown";
  const match = COMMON_LANGUAGES.find((l) => l.code === code);
  return match ? `${match.label} (${code})` : code;
}
