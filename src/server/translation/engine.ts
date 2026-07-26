/**
 * `TranslationEngine`, per docs/implementation-plan.md §3.3.
 *
 * The ONLY way the rest of the app should call into translation. It resolves the active
 * `TranslationProvider` from `TRANSLATION_PROVIDER` (openai|google|deepl|noop), loads any
 * applicable `TranslationGlossary` rows for the caller's org + language pair, merges those
 * terms into the translate call, and delegates to the provider. No other module should
 * import a provider class directly (`providers/openai.ts`, etc.) — that would bypass the
 * glossary merge and make the active provider un-swappable from one call site.
 */
import { env } from "../env";
import { glossaryRepository } from "../repositories/glossaryRepository";
import { DeepLProvider } from "./providers/deepl";
import { GoogleTranslateProvider } from "./providers/google";
import { NoopTranslationProvider } from "./providers/noop";
import { OpenAiTranslationProvider } from "./providers/openai";
import type { DetectLanguageResult, TranslateInput, TranslateResult, TranslationProvider } from "./types";

/** Input to `TranslationEngine.translate` — a `TranslateInput` plus the org to scope glossary lookups to. */
export type EngineTranslateInput = TranslateInput & { organizationId: string };

function createProvider(providerName: (typeof env)["TRANSLATION_PROVIDER"]): TranslationProvider {
  switch (providerName) {
    case "openai":
      return new OpenAiTranslationProvider();
    case "google":
      return new GoogleTranslateProvider();
    case "deepl":
      return new DeepLProvider();
    case "noop":
      return new NoopTranslationProvider();
    default: {
      // Exhaustiveness guard: env.ts's Zod enum already restricts TRANSLATION_PROVIDER to
      // the four values above, so this branch is unreachable at runtime.
      const _exhaustive: never = providerName;
      throw new Error(`Unknown TRANSLATION_PROVIDER: ${String(_exhaustive)}`);
    }
  }
}

export class TranslationEngine {
  private readonly provider: TranslationProvider;

  /**
   * Accepts an optional provider override for tests (or for callers that need to force a
   * specific provider). In production code, leave this unset — the active provider is
   * resolved from `env.TRANSLATION_PROVIDER`.
   */
  constructor(provider?: TranslationProvider) {
    this.provider = provider ?? createProvider(env.TRANSLATION_PROVIDER);
  }

  /** The resolved provider's name — mostly useful for logging/diagnostics. */
  get providerName(): TranslationProvider["name"] {
    return this.provider.name;
  }

  async detectLanguage(text: string): Promise<DetectLanguageResult> {
    return this.provider.detectLanguage(text);
  }

  /**
   * Translates `text` into `targetLanguage`, merging any org glossary rows that match the
   * resolved source/target language pair with any glossary terms the caller already
   * supplied (caller-supplied terms are appended after — and so take precedence in a
   * provider that de-dupes by term order — org-level glossary terms).
   *
   * Glossary lookup requires a known `sourceLanguage`: if the caller hasn't resolved one
   * yet (translation is being asked to detect-and-translate in one call), no org glossary
   * is applied for that call — callers on the inbound lifecycle (§3.5) already call
   * `detectLanguage` first specifically so this lookup can happen.
   */
  async translate(input: EngineTranslateInput): Promise<TranslateResult> {
    const { organizationId, glossary: callerGlossary, ...translateInput } = input;

    const orgGlossaryTerms = translateInput.sourceLanguage
      ? await glossaryRepository.findApplicableTerms(
          organizationId,
          translateInput.sourceLanguage,
          translateInput.targetLanguage,
        )
      : [];

    const mergedGlossary = [...orgGlossaryTerms, ...(callerGlossary ?? [])];

    return this.provider.translate({
      ...translateInput,
      glossary: mergedGlossary.length > 0 ? mergedGlossary : undefined,
    });
  }
}

/**
 * Process-wide default engine, built from `env.TRANSLATION_PROVIDER`. Prefer this over
 * constructing a new `TranslationEngine` per call site; construct one explicitly only in
 * tests (passing a fake `TranslationProvider`) or other special cases.
 */
export const translationEngine = new TranslationEngine();
