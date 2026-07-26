/**
 * `OpenAiTranslationProvider` — the one real, wired-up `TranslationProvider`, per
 * docs/implementation-plan.md §2.3/§3.3.
 *
 * Uses a single chat-completions call with `temperature: 0` and a strict JSON-schema
 * response format to do both `detectLanguage` and `translate` in one round trip. The
 * system/user prompt text itself lives in `../prompt.ts` (kept separate and pure so it
 * can be unit-tested without a network call or a mocked SDK); this file is only
 * responsible for wiring that prompt into an actual OpenAI request and parsing the
 * response back into our typed result shapes.
 *
 * Configuration: reads `OPENAI_API_KEY` via `src/server/env.ts` (never `process.env`
 * directly) and only at call time — importing this module, or constructing this class,
 * never throws and never requires an API key. `NotConfiguredError` is thrown from inside
 * `detectLanguage`/`translate` if the key is missing when one of those methods is
 * actually invoked, so the app can still boot (and other providers still work) with
 * `TRANSLATION_PROVIDER=openai` selected but no key set — though in that configuration
 * every translation call will fail until a key is supplied.
 */
import OpenAI from "openai";
import { z } from "zod";
import { env } from "../../env";
import { AppError, NotConfiguredError, UpstreamAdapterError } from "../../errors";
import {
  buildDetectLanguageSystemPrompt,
  buildDetectLanguageUserPrompt,
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
} from "../prompt";
import type { DetectLanguageResult, TranslateInput, TranslateResult, TranslationProvider } from "../types";

/**
 * Minimal shape of the OpenAI client surface this provider actually calls. Declaring it
 * as a narrow interface (rather than depending on the full `OpenAI` class) is what makes
 * the provider trivially unit-testable: tests pass a fake object satisfying this shape
 * instead of a real network client, and TypeScript still checks the call site.
 */
export interface OpenAiChatClient {
  chat: {
    completions: {
      create: (params: Record<string, unknown>) => Promise<{
        choices: { message: { content: string | null } }[];
      }>;
    };
  };
}

/**
 * Chat-completions model used for translation/detection. Kept as a single constant
 * (rather than an env var) since the plan does not call for it to be operator-configurable
 * in the MVP — revisit if that need arises.
 */
const OPENAI_TRANSLATION_MODEL = "gpt-4o-mini";

const translateResponseSchema = z.object({
  translatedText: z.string(),
  sourceLanguage: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const detectLanguageResponseSchema = z.object({
  language: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

const TRANSLATE_JSON_SCHEMA = {
  name: "translation_result",
  strict: true,
  schema: {
    type: "object",
    properties: {
      translatedText: {
        type: "string",
        description: "The translated message text.",
      },
      sourceLanguage: {
        type: "string",
        description:
          "BCP-47 code of the source language — either the language supplied by the " +
          "caller, echoed back, or (if none was supplied) the detected source language.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Self-reported confidence in the translation, 0–1.",
      },
    },
    required: ["translatedText", "sourceLanguage", "confidence"],
    additionalProperties: false,
  },
} as const;

const DETECT_LANGUAGE_JSON_SCHEMA = {
  name: "language_detection_result",
  strict: true,
  schema: {
    type: "object",
    properties: {
      language: {
        type: "string",
        description: "BCP-47 code of the detected language.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Self-reported confidence in the detected language, 0–1.",
      },
    },
    required: ["language", "confidence"],
    additionalProperties: false,
  },
} as const;

export class OpenAiTranslationProvider implements TranslationProvider {
  readonly name = "openai" as const;

  private client: OpenAiChatClient | null = null;

  /**
   * Accepts an optional client override so tests can inject a fake `OpenAiChatClient`
   * without hitting the network. In production code, leave this unset — a real `OpenAI`
   * client is lazily constructed from `env.OPENAI_API_KEY` the first time it's needed.
   */
  constructor(private readonly overrideClient?: OpenAiChatClient) {}

  private getClient(): OpenAiChatClient {
    if (this.overrideClient) {
      return this.overrideClient;
    }
    if (!this.client) {
      if (!env.OPENAI_API_KEY) {
        throw new NotConfiguredError(
          "OPENAI_API_KEY is not set; the OpenAI translation provider cannot be used. Set " +
            'OPENAI_API_KEY, or switch TRANSLATION_PROVIDER to "noop" for local dev/tests.',
        );
      }
      this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY }) as unknown as OpenAiChatClient;
    }
    return this.client;
  }

  async detectLanguage(text: string): Promise<DetectLanguageResult> {
    const client = this.getClient();
    try {
      const completion = await client.chat.completions.create({
        model: OPENAI_TRANSLATION_MODEL,
        temperature: 0,
        response_format: { type: "json_schema", json_schema: DETECT_LANGUAGE_JSON_SCHEMA },
        messages: [
          { role: "system", content: buildDetectLanguageSystemPrompt() },
          { role: "user", content: buildDetectLanguageUserPrompt(text) },
        ],
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new UpstreamAdapterError(
          "OpenAI returned an empty response while detecting language.",
        );
      }

      const parsed = detectLanguageResponseSchema.parse(JSON.parse(content));
      return { language: parsed.language, confidence: parsed.confidence };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new UpstreamAdapterError(
        "OpenAI translation provider failed to detect language.",
        { cause: error },
      );
    }
  }

  async translate(input: TranslateInput): Promise<TranslateResult> {
    const client = this.getClient();
    try {
      const completion = await client.chat.completions.create({
        model: OPENAI_TRANSLATION_MODEL,
        temperature: 0,
        response_format: { type: "json_schema", json_schema: TRANSLATE_JSON_SCHEMA },
        messages: [
          {
            role: "system",
            content: buildTranslateSystemPrompt({
              sourceLanguage: input.sourceLanguage,
              targetLanguage: input.targetLanguage,
              glossary: input.glossary,
            }),
          },
          { role: "user", content: buildTranslateUserPrompt(input.text) },
        ],
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new UpstreamAdapterError("OpenAI returned an empty response while translating.");
      }

      const parsed = translateResponseSchema.parse(JSON.parse(content));
      return {
        translatedText: parsed.translatedText,
        // Prefer the caller-supplied source language over the model's echo — the model
        // is only asked to determine it itself when the caller didn't supply one.
        sourceLanguage: input.sourceLanguage ?? parsed.sourceLanguage,
        targetLanguage: input.targetLanguage,
        confidence: parsed.confidence,
        provider: "openai",
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new UpstreamAdapterError(
        "OpenAI translation provider failed to translate text.",
        { cause: error },
      );
    }
  }
}
