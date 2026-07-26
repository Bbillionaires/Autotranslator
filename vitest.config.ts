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
