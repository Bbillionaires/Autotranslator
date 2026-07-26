/**
 * `NoopTranslationProvider`, per docs/implementation-plan.md §3.3.
 *
 * Echoes the input text back unchanged with `confidence: 0` and makes zero external
 * calls. Used as the default `TRANSLATION_PROVIDER` for local dev/tests so the whole
 * message pipeline is exercisable with no API key configured at all.
 */
import type { DetectLanguageResult, TranslateInput, TranslateResult, TranslationProvider } from "../types";

/** Reported as the detected language when there is no real detection to perform. */
const DEFAULT_DETECTED_LANGUAGE = "en";

export class NoopTranslationProvider implements TranslationProvider {
  readonly name = "noop" as const;

  async detectLanguage(_text: string): Promise<DetectLanguageResult> {
    return { language: DEFAULT_DETECTED_LANGUAGE, confidence: 0 };
  }

  async translate(input: TranslateInput): Promise<TranslateResult> {
    return {
      translatedText: input.text,
      sourceLanguage: input.sourceLanguage ?? input.targetLanguage,
      targetLanguage: input.targetLanguage,
      confidence: 0,
      provider: "noop",
    };
  }
}
