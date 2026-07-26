/**
 * Module augmentation for Auth.js types: adds our custom session/JWT claims
 * (`organizationId`, `role`) per docs/implementation-plan.md §2.2.
 *
 * This file has no runtime exports — it exists purely to extend the `next-auth` module's
 * ambient types. It must be imported (or included via tsconfig) so TypeScript picks up
 * the augmentation; importing it once from src/server/auth.ts is sufficient project-wide
 * because ambient module augmentations are global once loaded into the program.
 */
import type { Role } from "@prisma/client";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      organizationId: string;
      role: Role;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }

  interface User {
    organizationId?: string;
    role?: Role;
  }
}

// Note: we deliberately do NOT `declare module "next-auth/jwt"` here — under this
// project's `moduleResolution: "bundler"`, TypeScript cannot resolve that subpath export
// for augmentation purposes (a known TS limitation with package.json `exports` maps +
// `declare module`) and errors with TS2664. This is harmless in practice: the library's
// `JWT` interface already extends `Record<string, unknown>`, so assigning our custom
// claims (`token.userId = ...`, etc.) in `callbacks.jwt` type-checks fine without
// augmentation; call sites read them back with an explicit cast (see src/server/auth.ts).

export {};
