/**
 * JWT session-refresh DB re-check — NEW-2 fix (docs/review-report.md "Final Review").
 *
 * Extracted out of `auth.ts`'s `jwt` callback into its own module so it's directly
 * unit-testable, WITHOUT transitively importing `next-auth`/`next/server` — the same
 * reason `credentialsAuth.ts` exists as its own module (see that file's doc comment: importing
 * `auth.ts` directly from a test pulls in the full `NextAuth(...)` call, which fails to
 * resolve under this repo's Vitest "node" environment).
 *
 * ## The bug this fixes
 * Before this fix, `auth.ts`'s `jwt` callback only ever set `userId`/`organizationId`/`role`
 * from the DB `user` object at the moment of initial sign-in (`if (user) { ... }`); every
 * subsequent request returned the token completely unchanged, with no DB re-check at all.
 * `deactivateUser`/`updateUserRole` (the H3 fix) write to the `User` row, but a user with an
 * already-issued JWT kept acting under their OLD role/active-status for the rest of that
 * session's lifetime (previously up to the NextAuth default of 30 days, since this app set
 * no `maxAge` override) — deactivation/demotion were enforced at the next *sign-in* only,
 * never against an already-open session, which defeats the entire point of "an Administrator
 * can cut off a user's access right now."
 *
 * ## The fix
 * `auth.ts` now sets a short `session.maxAge`/`jwt.maxAge` (see its own comment for the
 * chosen value and the responsiveness-vs-DB-load tradeoff) AND calls `refreshSessionTokenClaims`
 * below from the `jwt` callback's refresh path (i.e. whenever the callback runs without a
 * fresh `user` object — every request under this app's JWT strategy, per Auth.js's own
 * callback doc: "Otherwise, it will be the full JWT for subsequent calls"). That function
 * re-fetches the current `role`/`deactivatedAt` from the DB and either:
 *   (a) returns `null` if the user is now deactivated (or the row no longer exists) — the
 *       `jwt` callback returning `null` invalidates the token, so `auth()`/`getSession()`
 *       comes back empty and the user is effectively signed out on their very next request; or
 *   (b) returns the token with `role` updated to whatever the DB currently says, so a
 *       demotion (or promotion) takes effect immediately rather than waiting for re-sign-in.
 *
 * ## Why not switch to database sessions instead (the plan's own §2.2 "future" idea)?
 * The `Session` Prisma model already exists (kept for exactly this reason per §2.2), and
 * database sessions would give truly instant revocation with zero polling delay — genuinely
 * the "more complete" fix the Final Review flagged as worth considering. It was NOT chosen
 * here because Auth.js's Credentials provider does not support the `"database"` session
 * strategy: the adapter's `createSession` is only ever invoked for OAuth/Email sign-ins, not
 * for `Credentials.authorize()`, so switching `session.strategy` to `"database"` would silently
 * break every Credentials sign-in in this app (Credentials is stated by Auth.js's own docs to
 * require JWT sessions) — i.e. it is NOT "not significantly more work," it would require
 * building a fully custom session-table read/write path, duplicating what the adapter
 * already almost does automatically for other providers. The JWT-refresh-with-DB-recheck
 * approach below achieves the same practical outcome (deactivation/demotion enforced within
 * a short, bounded window) without that rewrite.
 */
import type { Role } from "@prisma/client";
import { prisma } from "./db";
import { logger } from "./logger";

export interface SessionTokenClaims {
  userId?: string;
  organizationId?: string;
  role?: Role;
  [key: string]: unknown;
}

/**
 * Re-checks the DB for the current `role`/`deactivatedAt` of the user a session token
 * claims to belong to. Returns:
 *   - `null` if the token should be invalidated (no `userId` claim at all — a malformed/
 *     pre-fix token — or the user is deactivated, or the user row no longer exists);
 *   - the token, with `role`/`organizationId` refreshed to the DB's current values,
 *     otherwise.
 *
 * Called from `auth.ts`'s `jwt` callback refresh path (see module doc comment above for
 * when that runs) — never called during initial sign-in, since at that moment the token is
 * built directly from the just-verified `user` object instead (no extra DB round trip
 * needed for data `verifyCredentials` just fetched).
 */
export async function refreshSessionTokenClaims(token: SessionTokenClaims): Promise<SessionTokenClaims | null> {
  if (!token.userId) {
    logger.warn("Session token refresh: token has no userId claim; invalidating.");
    return null;
  }

  const user = await prisma.user.findUnique({ where: { id: token.userId } });
  if (!user) {
    logger.warn({ userId: token.userId }, "Session token refresh: user no longer exists; invalidating.");
    return null;
  }
  if (user.deactivatedAt) {
    logger.warn({ userId: token.userId }, "Session token refresh: user is deactivated; invalidating.");
    return null;
  }

  return {
    ...token,
    organizationId: user.organizationId,
    role: user.role,
  };
}
