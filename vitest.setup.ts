/**
 * Global Vitest setup. Seeds the env vars `src/server/env.ts` requires unconditionally
 * (see docs/implementation-plan.md §6.7) so any test that imports server modules —
 * directly or transitively — never throws at import time and never needs a real `.env`
 * file, a live database, or any real API key. Individual tests still control
 * TRANSLATION_PROVIDER/OPENAI_API_KEY/etc. themselves where that matters.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/autotranslator_test";
process.env.DIRECT_URL ??= "postgresql://test:test@localhost:5432/autotranslator_test";
process.env.AUTH_SECRET ??= "test-only-auth-secret-do-not-use-in-production";
process.env.APP_URL ??= "http://localhost:3000";
