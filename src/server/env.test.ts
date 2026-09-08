/**
 * Tests for `src/server/env.ts`'s conditional-requirement logic, per
 * docs/implementation-plan.md §6.7 and the Builder task's per-org-credential rewrite.
 * `env.ts` parses `process.env` and throws at MODULE IMPORT TIME, so every case here uses
 * `vi.resetModules()` + a dynamic `await import("./env")` against a freshly-constructed
 * `process.env` snapshot — same pattern as `src/server/channels/index.test.ts`.
 *
 * `process.env` is a single mutable object shared across every test FILE that runs in the
 * same Vitest worker (Node doesn't sandbox its built-in `process` per file the way module
 * imports get isolated), and this suite's `fileParallelism: false` setting means other test
 * files' env mutations (e.g. `TELEGRAM_ENABLED="true"`) can genuinely still be sitting in
 * `process.env` by the time this file's tests run. So — rather than trusting whatever
 * `process.env` happens to contain — every test here starts by explicitly DELETING every key
 * `env.ts` reads (`ALL_ENV_KEYS` below) and then sets back only exactly what that specific
 * case needs. This is what makes the "zero credentials, keys genuinely ABSENT" assertion
 * trustworthy regardless of test execution order.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

const VALID_CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);

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
  "ANDROID_GATEWAY_ENABLED",
  "ANDROID_GATEWAY_SIGNING_SECRET",
  "WHATSAPP_ENABLED",
  "CREDENTIAL_ENCRYPTION_KEY",
  "INTERNAL_WORKER_SECRET",
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
  it("validates successfully with every WHATSAPP/TELEGRAM/ANDROID_GATEWAY/CREDENTIAL_ENCRYPTION_KEY key genuinely ABSENT (not just false)", async () => {
    resetToUnconditionalBaseEnv();

    const { env } = await import("./env");
    expect(env.WHATSAPP_ENABLED).toBe(false);
    expect(env.TELEGRAM_ENABLED).toBe(false);
    expect(env.ANDROID_GATEWAY_ENABLED).toBe(false);
    expect(env.CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
  });

  it("validates successfully with every *_ENABLED flag explicitly 'false'", async () => {
    resetToUnconditionalBaseEnv();
    process.env.WHATSAPP_ENABLED = "false";
    process.env.TELEGRAM_ENABLED = "false";
    process.env.ANDROID_GATEWAY_ENABLED = "false";

    const { env } = await import("./env");
    expect(env.WHATSAPP_ENABLED).toBe(false);
    expect(env.TELEGRAM_ENABLED).toBe(false);
    expect(env.ANDROID_GATEWAY_ENABLED).toBe(false);
  });
});

describe("env.ts — CREDENTIAL_ENCRYPTION_KEY conditional requirement", () => {
  it("throws when TELEGRAM_ENABLED=true and CREDENTIAL_ENCRYPTION_KEY is unset", async () => {
    resetToUnconditionalBaseEnv();
    process.env.TELEGRAM_ENABLED = "true";

    await expect(import("./env")).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it("throws when WHATSAPP_ENABLED=true and CREDENTIAL_ENCRYPTION_KEY is unset", async () => {
    resetToUnconditionalBaseEnv();
    process.env.WHATSAPP_ENABLED = "true";

    await expect(import("./env")).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it("throws when ANDROID_GATEWAY_ENABLED=true and CREDENTIAL_ENCRYPTION_KEY is unset", async () => {
    resetToUnconditionalBaseEnv();
    process.env.ANDROID_GATEWAY_ENABLED = "true";
    process.env.ANDROID_GATEWAY_SIGNING_SECRET = "test-signing-secret";

    await expect(import("./env")).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it("throws when CREDENTIAL_ENCRYPTION_KEY is set but the wrong length/format (not 64 hex chars)", async () => {
    resetToUnconditionalBaseEnv();
    process.env.TELEGRAM_ENABLED = "true";
    process.env.CREDENTIAL_ENCRYPTION_KEY = "too-short";

    await expect(import("./env")).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it("validates successfully once CREDENTIAL_ENCRYPTION_KEY (64 hex chars) is set alongside TELEGRAM_ENABLED=true", async () => {
    resetToUnconditionalBaseEnv();
    process.env.TELEGRAM_ENABLED = "true";
    process.env.CREDENTIAL_ENCRYPTION_KEY = VALID_CREDENTIAL_ENCRYPTION_KEY;

    const { env } = await import("./env");
    expect(env.TELEGRAM_ENABLED).toBe(true);
    expect(env.CREDENTIAL_ENCRYPTION_KEY).toBe(VALID_CREDENTIAL_ENCRYPTION_KEY);
  });

  it("validates successfully once CREDENTIAL_ENCRYPTION_KEY is set alongside WHATSAPP_ENABLED=true", async () => {
    resetToUnconditionalBaseEnv();
    process.env.WHATSAPP_ENABLED = "true";
    process.env.CREDENTIAL_ENCRYPTION_KEY = VALID_CREDENTIAL_ENCRYPTION_KEY;

    const { env } = await import("./env");
    expect(env.WHATSAPP_ENABLED).toBe(true);
  });

  it("does not require CREDENTIAL_ENCRYPTION_KEY when every channel flag is false", async () => {
    resetToUnconditionalBaseEnv();

    const { env } = await import("./env");
    expect(env.CREDENTIAL_ENCRYPTION_KEY).toBeUndefined();
  });
});
