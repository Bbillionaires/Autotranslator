/**
 * Translation-engine interfaces, verbatim from docs/implementation-plan.md §3.3.
 *
 * `TranslationProvider` is the interface every provider (`OpenAiTranslationProvider`,
 * `NoopTranslationProvider`, and the reserved `GoogleTranslateProvider`/`DeepLProvider`
 * stubs) implements. Nothing outside `src/server/translation/` should depend on a
 * specific provider — `TranslationEngine` (./engine.ts) is the only sanctioned entry
 * point for the rest of the app.
 */

export interface DetectLanguageResult {
  language: string; // BCP-47 code, e.g. "es", "pt-BR"
  confidence: number; // 0–1
}

export interface TranslateInput {
  text: string;
  sourceLanguage?: string; // omit to let the provider detect
  targetLanguage: string;
  glossary?: { term: string; translation: string }[];
}

export interface TranslateResult {
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  confidence: number;
  provider: "openai" | "google" | "deepl" | "noop";
}

export interface TranslationProvider {
  readonly name: TranslateResult["provider"];
  detectLanguage(text: string): Promise<DetectLanguageResult>;
  translate(input: TranslateInput): Promise<TranslateResult>;
}
