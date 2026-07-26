/**
 * Process-env validation, per docs/implementation-plan.md §6.7.
 *
 * This module parses `process.env` through a Zod schema exactly once at import time and
 * throws a descriptive error (listing every missing/invalid variable) if validation fails.
 * It is imported from server-only code paths (never from client components).
 *
 * Conditional-requirement rules (exactly as specified in the plan):
 *  - WHATSAPP_* vars are required only when WHATSAPP_ENABLED === "true".
 *  - ANDROID_GATEWAY_SIGNING_SECRET is required only when ANDROID_GATEWAY_ENABLED === "true".
 *  - TELEGRAM_* vars are required only when TELEGRAM_ENABLED === "true".
 *  - TRANSLATION_PROVIDER selects which of OPENAI_API_KEY / GOOGLE_TRANSLATE_API_KEY /
 *    DEEPL_API_KEY is required (none are required for the default "noop" provider).
 *
 * With every `*_ENABLED` flag left unset/false and only DATABASE_URL / DIRECT_URL /
 * AUTH_SECRET / APP_URL set, validation must pass — this is the Phase 3 "zero-credential
 * boot" acceptance test.
 */
import { z } from "zod";

const booleanFlag = z
  .enum(["true", "false"])
  .optional()
  .default("false")
  .transform((value) => value === "true");

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional().default("development"),

  // ---- Base required vars ----
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().min(1, "DIRECT_URL is required"),
  AUTH_SECRET: z.string().min(1, "AUTH_SECRET is required"),
  APP_URL: z.string().min(1, "APP_URL is required").url("APP_URL must be a valid URL"),

  // ---- Logging ----
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional()
    .default("info"),

  // ---- Translation provider ----
  TRANSLATION_PROVIDER: z.enum(["openai", "google", "deepl", "noop"]).optional().default("noop"),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_TRANSLATE_API_KEY: z.string().optional(),
  DEEPL_API_KEY: z.string().optional(),

  // ---- Email provider (Auth.js magic link) ----
  // Optional: when unset, the Email provider logs magic links to the console instead of
  // sending real email (see src/server/auth.ts).
  EMAIL_SERVER: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),

  // ---- Telegram ----
  TELEGRAM_ENABLED: booleanFlag,
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // ---- Android SMS gateway ----
  ANDROID_GATEWAY_ENABLED: booleanFlag,
  ANDROID_GATEWAY_SIGNING_SECRET: z.string().optional(),

  // ---- WhatsApp Business Cloud API ----
  WHATSAPP_ENABLED: booleanFlag,
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
});

type RawEnv = z.infer<typeof rawEnvSchema>;

/** Collects every conditional-requirement violation into human-readable messages. */
function collectConditionalErrors(env: RawEnv): string[] {
  const errors: string[] = [];

  if (env.TELEGRAM_ENABLED) {
    if (!env.TELEGRAM_BOT_TOKEN) {
      errors.push("TELEGRAM_BOT_TOKEN is required when TELEGRAM_ENABLED=true");
    }
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      errors.push("TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_ENABLED=true");
    }
  }

  if (env.ANDROID_GATEWAY_ENABLED) {
    if (!env.ANDROID_GATEWAY_SIGNING_SECRET) {
      errors.push("ANDROID_GATEWAY_SIGNING_SECRET is required when ANDROID_GATEWAY_ENABLED=true");
    }
  }

  if (env.WHATSAPP_ENABLED) {
    const requiredWhatsAppVars: Array<[keyof RawEnv, string]> = [
      ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_ACCESS_TOKEN"],
      ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_PHONE_NUMBER_ID"],
      ["WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID"],
      ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_VERIFY_TOKEN"],
      ["WHATSAPP_APP_SECRET", "WHATSAPP_APP_SECRET"],
    ];
    for (const [key, name] of requiredWhatsAppVars) {
      if (!env[key]) {
        errors.push(`${name} is required when WHATSAPP_ENABLED=true`);
      }
    }
  }

  if (env.TRANSLATION_PROVIDER === "openai" && !env.OPENAI_API_KEY) {
    errors.push("OPENAI_API_KEY is required when TRANSLATION_PROVIDER=openai");
  }
  if (env.TRANSLATION_PROVIDER === "google" && !env.GOOGLE_TRANSLATE_API_KEY) {
    errors.push("GOOGLE_TRANSLATE_API_KEY is required when TRANSLATION_PROVIDER=google");
  }
  if (env.TRANSLATION_PROVIDER === "deepl" && !env.DEEPL_API_KEY) {
    errors.push("DEEPL_API_KEY is required when TRANSLATION_PROVIDER=deepl");
  }

  return errors;
}

function loadEnv(): RawEnv {
  const parsed = rawEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(
      `Invalid environment configuration. The following variables are missing or invalid:\n` +
        missing.map((m) => `  - ${m}`).join("\n"),
    );
  }

  const conditionalErrors = collectConditionalErrors(parsed.data);
  if (conditionalErrors.length > 0) {
    throw new Error(
      `Invalid environment configuration. The following variables are missing or invalid:\n` +
        conditionalErrors.map((m) => `  - ${m}`).join("\n"),
    );
  }

  return parsed.data;
}

export const env = loadEnv();

export type Env = typeof env;
