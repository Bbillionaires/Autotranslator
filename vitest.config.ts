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
    // Phase 7 adds React Testing Library component tests (*.test.tsx) alongside the
    // existing server-side *.test.ts files. Those opt into jsdom per-file via a
    // `// @vitest-environment jsdom` docblock (see e.g.
    // src/app/(app)/inbox/[conversationId]/message-thread.test.tsx) rather than switching
    // the whole suite to jsdom, since the vast majority of tests here are server-side
    // Prisma/Vitest integration tests that are faster and more correct under "node".
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
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
      // Every test file here exercises server-side code. Vitest has no notion of Next.js's
      // "react-server" resolve condition — the mechanism that makes `import "server-only"`
      // (added to src/server/env.ts) resolve to a no-op in a real server build and to a
      // throwing stub in a client build. Without this alias, `server-only`'s package.json
      // "default" export resolves to that throwing stub unconditionally, so any server
      // module importing it (e.g. env.ts) fails every test that imports it — even though
      // these are all server-context tests. Point it at the same no-op the real build uses
      // for server code.
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
    },
  },
});
