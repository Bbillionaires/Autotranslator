import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for server-side unit tests (Phase 4 onward). Tests are colocated with
 * the source they cover (`*.test.ts` next to the module), matching the pattern used by
 * `docs/implementation-plan.md` §9's "Unit (Vitest)" testing strategy. `vitest.setup.ts`
 * seeds the handful of env vars `src/server/env.ts` requires unconditionally
 * (DATABASE_URL/DIRECT_URL/AUTH_SECRET/APP_URL) so importing server modules in tests
 * never needs a real `.env` file or a live database.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Several integration test files share ONE physical test Postgres database and create
    // their own Organization/ChannelAccount rows, cleaning them up in `afterEach`. Almost
    // all of them scope every query by their own `organizationId`, so running test FILES in
    // parallel (Vitest's default) is safe. The one exception (added in Phase 6,
    // src/app/api/channels/telegram/webhook/route.test.ts) exercises a deliberately
    // cross-org lookup (`channelAccountRepository.findFirstActiveByChannelType` — the
    // Telegram webhook route's MVP "single global bot token" resolution strategy, see that
    // repository method's doc comment) which cannot be org-scoped by construction. Running
    // it concurrently with other files that also create ACTIVE Telegram ChannelAccount rows
    // races non-deterministically. Disabling file parallelism trades a slower `npm test` for
    // a suite that isn't flaky — acceptable at this project's current test-suite size.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/server/translation/**", "src/server/repositories/**", "src/server/validation/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
