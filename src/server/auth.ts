/**
 * Auth.js (NextAuth v5) configuration, per docs/implementation-plan.md §2.2 / §6.2.
 *
 * - Prisma adapter (Account/Session/VerificationToken models already in prisma/schema.prisma).
 * - Credentials provider: email + password, bcrypt compare against User.passwordHash.
 * - Email provider: magic link. In dev (no real email transport configured) the link is
 *   simply logged to the server console instead of being sent — this keeps `npm run dev`
 *   bootable with zero email-provider credentials, per the Phase 3 "zero-credential boot"
 *   requirement. Wiring a real transport (Resend, SMTP, ...) is a later-phase concern.
 * - JWT session strategy carrying custom claims: `userId`, `organizationId`, `role`.
 *
 * ## NEW-2 fix (docs/review-report.md "Final Review") — session revocation
 * Previously `maxAge` was unset (NextAuth default: 30 days) and the `jwt` callback never
 * re-checked the DB after initial sign-in, so `deactivateUser`/`updateUserRole` (the H3
 * fix) had no effect on a session that was already open — a deactivated/demoted user kept
 * acting under stale claims for up to 30 days. Fixed two ways, together:
 *   1. `maxAge: 30 * 60` (30 minutes) on both `session` and `jwt` below — short enough that
 *      a revoked/demoted user is fully cut off within half an hour even in the worst case;
 *      long enough to not force a re-sign-in every few minutes or hammer Postgres. This is
 *      a tradeoff, not a magic number: shorter (e.g. 15 min) would revoke faster at the cost
 *      of more frequent re-issuance/DB traffic; longer (e.g. 60 min) would be gentler on the
 *      DB but leave a wider revocation-lag window. 30 minutes was chosen as the midpoint of
 *      the review's own suggested 15-60 minute range.
 *   2. The `jwt` callback's refresh path (i.e. every call where `user` isn't freshly present
 *      — which, per Auth.js's own docs ("Otherwise, it will be the full JWT for subsequent
 *      calls"), is every request under this app's JWT strategy, not just the boundary of
 *      `maxAge`) now calls `refreshSessionTokenClaims` (`./authTokenRefresh.ts` — extracted
 *      for unit-testability, see its doc comment for the full rationale, including why
 *      database sessions were considered and NOT chosen). In practice this means role
 *      changes/deactivation are usually reflected on the very next request; `maxAge` is the
 *      hard upper bound in case a token is ever refreshed without invoking this callback's
 *      refresh branch (e.g. an unexpired cookie replayed without an intervening `auth()`
 *      call in this process).
 * Residual limitation: this is still poll/refresh-based, not instantaneous revocation like
 * database sessions would give — see `./authTokenRefresh.ts` for why that alternative was
 * rejected for this fix.
 */
import NextAuth from "next-auth";
import type { EmailConfig } from "@auth/core/providers/email";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "./db";
import { logger } from "./logger";
import { verifyCredentials } from "./credentialsAuth";
import { refreshSessionTokenClaims, type SessionTokenClaims } from "./authTokenRefresh";
import { userRepository } from "./repositories/userRepository";
import type { Role } from "@prisma/client";
import "./auth.types";

/**
 * How often a session's JWT is re-issued and, per the `jwt` callback below, has its
 * role/deactivated status re-checked against the DB. See the module doc comment's NEW-2
 * fix section for the full responsiveness-vs-DB-load tradeoff this value represents.
 */
const SESSION_MAX_AGE_SECONDS = 30 * 60; // 30 minutes

export { verifyCredentials } from "./credentialsAuth";
export type { AuthorizedCredentialsUser } from "./credentialsAuth";

/**
 * A minimal Auth.js "email" (magic link) provider that logs the sign-in link to the
 * server console. Swap `sendVerificationRequest` for a real transport (e.g. Resend) in a
 * later phase without touching anything else in the auth flow.
 */
function devConsoleEmailProvider(): EmailConfig {
  return {
    id: "email",
    type: "email",
    name: "Email",
    maxAge: 24 * 60 * 60, // 24 hours
    async sendVerificationRequest({ identifier, url }) {
      logger.info({ to: identifier }, "Magic link requested (dev mode: logged, not emailed)");
      console.log(
        `\n────────────────────────────────────────\n` +
          `Magic sign-in link for ${identifier}:\n${url}\n` +
          `────────────────────────────────────────\n`,
      );
    },
  };
}

// The stock @auth/prisma-adapter's `getUserByEmail` calls `prisma.user.findUnique({ where:
// { email } })`, which assumes `email` is a bare unique column. Our schema deliberately
// scopes email uniqueness to `@@unique([organizationId, email])` (email is only unique
// *within* an org — see docs/implementation-plan.md §4), so that call throws a
// PrismaClientValidationError at runtime. Override just this one method with a
// `findMany`-then-disambiguate lookup (see userRepository.findByEmail's doc comment for the
// "not org-scoped by design" rationale AND the M3 fix: throws instead of silently picking
// an arbitrary match when the same email exists in more than one org) — every other adapter
// method already keys off a genuinely unique column (id, sessionToken,
// provider+providerAccountId, identifier+token) and needs no change. Note: self-service
// sign-up via an unrecognized email is not a supported flow (this product is invite-only
// per the plan) — `createUser` would fail against our schema (organizationId/name are
// required) if ever reached for a brand-new email; that's intentional, not a bug to fix
// here.
const prismaAdapter = PrismaAdapter(prisma);
const adapter = {
  ...prismaAdapter,
  getUserByEmail: (email: string) => userRepository.findByEmail(email),
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter,
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  jwt: { maxAge: SESSION_MAX_AGE_SECONDS },
  pages: {
    signIn: "/sign-in",
  },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(rawCredentials, request) {
        return verifyCredentials(rawCredentials, request);
      },
    }),
    devConsoleEmailProvider(),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // `user` is only present on initial sign-in; persist the custom claims onto the
        // token so subsequent requests don't need a DB round trip to know org/role. No DB
        // re-check is needed here — `user` was already just fetched/verified fresh by
        // `verifyCredentials` moments ago.
        token.userId = user.id;
        token.organizationId = (user as { organizationId?: string }).organizationId;
        token.role = (user as { role?: Role }).role;
        return token;
      }

      // NEW-2 fix (docs/review-report.md "Final Review"): the refresh path — every call
      // that doesn't have a freshly-signed-in `user` object. Re-checks the DB's current
      // `role`/`deactivatedAt` (see `./authTokenRefresh.ts` for the full rationale) so a
      // deactivation/demotion takes effect within `SESSION_MAX_AGE_SECONDS` at most, not up
      // to the old 30-day default. Returning `null` invalidates the token entirely (Auth.js:
      // the `jwt` callback may return `JWT | null`), which is what makes a deactivated
      // user's session actually die instead of silently keeping stale claims.
      const refreshed = await refreshSessionTokenClaims(token as SessionTokenClaims);
      return refreshed as typeof token | null;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.userId as string;
        session.user.organizationId = token.organizationId as string;
        session.user.role = token.role as Role;
      }
      return session;
    },
  },
});
