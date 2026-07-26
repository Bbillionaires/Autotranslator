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

// Phase 7: extends `expect` with jest-dom matchers (toBeInTheDocument, etc.) for the new
// React Testing Library component tests. Harmless to import globally even for the
// "node"-environment server-side tests — it only adds matcher functions.
import "@testing-library/jest-dom/vitest";

// Auto-unmount React Testing Library renders between tests (RTL doesn't do this
// automatically outside of Jest's `testEnvironment` auto-registration). Harmless for
// "node"-environment tests that never call `render()` — `cleanup()` is a no-op when
// nothing was mounted.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
