/**
 * Test-only helper for Phase 5's integration tests (`inboundService.test.ts`,
 * `outboundService.test.ts`). Points `DATABASE_URL`/`DIRECT_URL` at the dedicated
 * `autotranslator_test` Postgres database (same docker-compose Postgres container as dev,
 * separate database — see docs/implementation-plan.md §9's "Integration (Vitest + a real
 * test Postgres...)" testing strategy) instead of the fake `postgresql://test:test@...`
 * value `vitest.setup.ts` uses as a default for tests that mock `../db` entirely.
 *
 * Call `configureTestDatabaseEnv()` at the very top of a test file, BEFORE any (dynamic)
 * import of `../db`/`../env`/anything that transitively imports them — env vars are read
 * once at module-import time, and Vitest's per-file module isolation means this only needs
 * to happen once per test file, not globally.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://autotranslator:autotranslator_dev_password@localhost:5432/autotranslator_test?schema=public";

export function configureTestDatabaseEnv(): void {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.DIRECT_URL = TEST_DATABASE_URL;
  process.env.TRANSLATION_PROVIDER = "noop";
}
