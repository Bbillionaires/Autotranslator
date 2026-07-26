/**
 * `DeepLProvider` — reserved, unimplemented, per docs/implementation-plan.md §2.3/§3.3.
 *
 * This class exists purely to prove `TranslationProvider` truly supports swapping in a
 * second provider as an isolated, additive change: it implements the full interface, but
 * every method throws `NotImplementedError` instead of calling the DeepL API.
 * `DEEPL_API_KEY` is reserved in `.env.example` for when this is built out; it is not
 * read here on purpose (there is nothing to configure yet).
 */
import { NotImplementedError } from "../../errors";
import type { DetectLanguageResult, TranslateInput, TranslateResult, TranslationProvider } from "../types";

const NOT_IMPLEMENTED_MESSAGE =
  "DeepLProvider is reserved for a future implementation (see docs/implementation-plan.md " +
  '§2.3) and is not built yet. Set TRANSLATION_PROVIDER to "openai" or "noop" instead.';

export class DeepLProvider implements TranslationProvider {
  readonly name = "deepl" as const;

  async detectLanguage(_text: string): Promise<DetectLanguageResult> {
    throw new NotImplementedError(NOT_IMPLEMENTED_MESSAGE);
  }

  async translate(_input: TranslateInput): Promise<TranslateResult> {
    throw new NotImplementedError(NOT_IMPLEMENTED_MESSAGE);
  }
}
