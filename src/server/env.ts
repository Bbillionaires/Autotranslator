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
  // TELEGRAM_ENABLED remains a global feature flag (gates whether the adapter/routes exist
  // at all). There is deliberately no global TELEGRAM_BOT_TOKEN/TELEGRAM_WEBHOOK_SECRET any
  // more — bot credentials are now per-organization, entered via Settings and stored
  // encrypted on ChannelAccount.encryptedCredentials (see
  // src/server/channels/telegram/credentials.ts and docs/channel-adapters.md).
  TELEGRAM_ENABLED: booleanFlag,

  // ---- Android SMS gateway ----
  ANDROID_GATEWAY_ENABLED: booleanFlag,
  ANDROID_GATEWAY_SIGNING_SECRET: z.string().optional(),

  // ---- WhatsApp Business Cloud API ----
  // WHATSAPP_ENABLED remains a global feature flag; the five credential vars this used to
  // require (WHATSAPP_ACCESS_TOKEN/PHONE_NUMBER_ID/BUSINESS_ACCOUNT_ID/VERIFY_TOKEN/
  // APP_SECRET) are gone the same way Telegram's are — per-organization credentials now,
  // see src/server/channels/whatsapp/credentials.ts.
  WHATSAPP_ENABLED: booleanFlag,

  // ---- Per-organization channel credential encryption ----
  // AES-256-GCM key (32 bytes, hex-encoded — 64 hex characters) used to encrypt/decrypt
  // every ChannelAccount's stored credentials (see src/server/crypto/credentialEncryption.ts).
  // Generate one for local dev with: openssl rand -hex 32
  // Required only when at least one channel that stores per-org credentials this way is
  // enabled (TELEGRAM_ENABLED, WHATSAPP_ENABLED, or ANDROID_GATEWAY_ENABLED) — preserving
  // the zero-credential-boot guarantee for a deployment with every channel disabled.
  CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters (32 bytes, e.g. from `openssl rand -hex 32`)")
    .optional(),

  // ---- Internal retry worker (H4 fix, docs/review-report.md) ----
  // Optional-but-recommended: protects GET/POST /api/internal/retry-worker (the endpoint an
  // external scheduler hits periodically to drive automatic message retries) with a
  // shared-secret header check. Never required for boot (this endpoint is opt-in
  // infrastructure, not a core feature flag) — if unset, the route itself refuses to run
  // rather than operating unauthenticated (see that route's doc comment).
  INTERNAL_WORKER_SECRET: z.string().optional(),
});

type RawEnv = z.infer<typeof rawEnvSchema>;

/** Collects every conditional-requirement violation into human-readable messages. */
function collectConditionalErrors(env: RawEnv): string[] {
  const errors: string[] = [];

  if (env.ANDROID_GATEWAY_ENABLED) {
    if (!env.ANDROID_GATEWAY_SIGNING_SECRET) {
      errors.push("ANDROID_GATEWAY_SIGNING_SECRET is required when ANDROID_GATEWAY_ENABLED=true");
    }
  }

  // CREDENTIAL_ENCRYPTION_KEY guards per-organization channel credentials at rest
  // (src/server/crypto/credentialEncryption.ts). Required whenever a channel that stores
  // credentials this way could be enabled — Telegram and WhatsApp always do; Android is
  // included per the same conditional-requirement spirit even though its existing
  // device-token-hash mechanism doesn't itself need this key, so a deployment turning any
  // one of the three on always has it available.
  if ((env.TELEGRAM_ENABLED || env.WHATSAPP_ENABLED || env.ANDROID_GATEWAY_ENABLED) && !env.CREDENTIAL_ENCRYPTION_KEY) {
    errors.push(
      "CREDENTIAL_ENCRYPTION_KEY is required when TELEGRAM_ENABLED, WHATSAPP_ENABLED, or ANDROID_GATEWAY_ENABLED is true",
    );
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
