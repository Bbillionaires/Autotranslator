/**
 * Tests for `src/server/env.ts`'s conditional-requirement logic, per
 * docs/implementation-plan.md §6.7 and the Phase 9 task brief's "extra rigor on the 'boots
 * with zero credentials' requirement". `env.ts` parses `process.env` and throws at MODULE
 * IMPORT TIME, so every case here uses `vi.resetModules()` + a dynamic `await import("./env")`
 * against a freshly-constructed `process.env` snapshot — same pattern as
 * `src/server/channels/index.test.ts`.
 *
 * `process.env` is a single mutable object shared across every test FILE that runs in the
 * same Vitest worker (Node doesn't sandbox its built-in `process` per file the way module
 * imports get isolated), and this suite's `fileParallelism: false` setting means other test
 * files' env mutations (e.g. `TELEGRAM_ENABLED="true"`) can genuinely still be sitting in
 * `process.env` by the time this file's tests run. So — rather than trusting whatever
 * `process.env` happens to contain — every test here starts by explicitly DELETING every key
 * `env.ts` reads (`ALL_ENV_KEYS` below) and then sets back only exactly what that specific
 * case needs. This is what makes the "zero WhatsApp vars, keys genuinely ABSENT" assertion
 * trustworthy regardless of test execution order.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

/** Every key `src/server/env.ts` reads from `process.env` (see its `rawEnvSchema`). */
const ALL_ENV_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "DIRECT_URL",
  "AUTH_SECRET",
  "APP_URL",
  "LOG_LEVEL",
  "TRANSLATION_PROVIDER",
  "OPENAI_API_KEY",
  "GOOGLE_TRANSLATE_API_KEY",
  "DEEPL_API_KEY",
  "EMAIL_SERVER",
  "EMAIL_FROM",
  "RESEND_API_KEY",
  "TELEGRAM_ENABLED",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "ANDROID_GATEWAY_ENABLED",
  "ANDROID_GATEWAY_SIGNING_SECRET",
  "WHATSAPP_ENABLED",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
] as const;

/** Deletes every `env.ts`-relevant key, then sets only the unconditionally-required base four. */
function resetToUnconditionalBaseEnv(): void {
  for (const key of ALL_ENV_KEYS) {
    delete process.env[key];
  }
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.DIRECT_URL = "postgresql://test:test@localhost:5432/test";
  process.env.AUTH_SECRET = "test-only-secret";
  process.env.APP_URL = "http://localhost:3000";
}

afterEach(() => {
  vi.resetModules();
});

afterAll(() => {
  for (const key of ALL_ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("env.ts — zero-credential boot (docs/implementation-plan.md §6.7)", () => {
  it("validates successfully with every WHATSAPP_*/TELEGRAM_*/ANDROID_GATEWAY_* key genuinely ABSENT (not just false)", async () => {
    resetToUnconditionalBaseEnv();

    const { env } = await import("./env");
    expect(env.WHATSAPP_ENABLED).toBe(false);
    expect(env.WHATSAPP_ACCESS_TOKEN).toBeUndefined();
    expect(env.WHATSAPP_PHONE_NUMBER_ID).toBeUndefined();
    expect(env.WHATSAPP_BUSINESS_ACCOUNT_ID).toBeUndefined();
    expect(env.WHATSAPP_VERIFY_TOKEN).toBeUndefined();
    expect(env.WHATSAPP_APP_SECRET).toBeUndefined();
    expect(env.TELEGRAM_ENABLED).toBe(false);
    expect(env.ANDROID_GATEWAY_ENABLED).toBe(false);
  });

  it("validates successfully with WHATSAPP_ENABLED explicitly 'false' and no other WHATSAPP_* vars set", async () => {
    resetToUnconditionalBaseEnv();
    process.env.WHATSAPP_ENABLED = "false";

    const { env } = await import("./env");
    expect(env.WHATSAPP_ENABLED).toBe(false);
  });
});

describe("env.ts — WHATSAPP_ENABLED=true requires all five WhatsApp vars", () => {
  it("throws listing every missing WHATSAPP_* var when none are set", async () => {
    resetToUnconditionalBaseEnv();
    process.env.WHATSAPP_ENABLED = "true";

    await expect(import("./env")).rejects.toThrow(/WHATSAPP_ACCESS_TOKEN/);
    vi.resetModules();
    await expect(import("./env")).rejects.toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
    vi.resetModules();
    await expect(import("./env")).rejects.toThrow(/WHATSAPP_BUSINESS_ACCOUNT_ID/);
    vi.resetModules();
    await expect(import("./env")).rejects.toThrow(/WHATSAPP_VERIFY_TOKEN/);
    vi.resetModules();
    await expect(import("./env")).rejects.toThrow(/WHATSAPP_APP_SECRET/);
  });

  it("throws when only some of the five WhatsApp vars are set", async () => {
    resetToUnconditionalBaseEnv();
    process.env.WHATSAPP_ENABLED = "true";
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
    // WHATSAPP_BUSINESS_ACCOUNT_ID / WHATSAPP_VERIFY_TOKEN / WHATSAPP_APP_SECRET left unset.

    await expect(import("./env")).rejects.toThrow(/WHATSAPP_BUSINESS_ACCOUNT_ID/);
  });

  it("validates successfully once all five WhatsApp vars are set alongside WHATSAPP_ENABLED=true", async () => {
    resetToUnconditionalBaseEnv();
    process.env.WHATSAPP_ENABLED = "true";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "987654321";
    process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
    process.env.WHATSAPP_APP_SECRET = "test-app-secret";

    const { env } = await import("./env");
    expect(env.WHATSAPP_ENABLED).toBe(true);
    expect(env.WHATSAPP_ACCESS_TOKEN).toBe("test-access-token");
  });

  it("does not throw about Telegram/Android vars it doesn't need when only WhatsApp is enabled", async () => {
    resetToUnconditionalBaseEnv();
    process.env.WHATSAPP_ENABLED = "true";
    process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "987654321";
    process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
    process.env.WHATSAPP_APP_SECRET = "test-app-secret";

    const { env } = await import("./env");
    expect(env.TELEGRAM_ENABLED).toBe(false);
    expect(env.ANDROID_GATEWAY_ENABLED).toBe(false);
  });
});
