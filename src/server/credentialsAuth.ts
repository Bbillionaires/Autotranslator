/**
 * Credentials-provider verification logic, extracted out of `auth.ts` into its own module
 * so it's directly unit-testable (`credentialsAuth.test.ts`) WITHOUT transitively importing
 * `next-auth`/`next/server` (importing `auth.ts` directly from a test pulls in the full
 * `NextAuth(...)` call, which fails to resolve under this repo's Vitest "node" environment —
 * `next-auth/lib/env.js` imports a `next/server` subpath Vitest can't resolve outside a real
 * Next.js build/runtime context). `auth.ts`'s Credentials provider `authorize()` is a thin
 * wrapper that just forwards to `verifyCredentials` here.
 */
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Role } from "@prisma/client";
import { prisma } from "./db";
import { logger } from "./logger";
import { authRateLimiter, getClientIp } from "./rateLimit";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export interface AuthorizedCredentialsUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  organizationId: string;
  role: Role;
}

/**
 * ## H2 fix — rate limiting (docs/review-report.md)
 * §6.4 requires rate limiting on "the auth sign-in ... endpoints (to blunt credential
 * stuffing / email-bombing)". Keyed by IP+email so one attacker can't lock out a legitimate
 * user's email from a different IP, and one IP spraying many different emails is still
 * bounded per-email. A rate-limited attempt is rejected exactly like a wrong password
 * (returns `null`, no distinguishing signal) — see `getClientIp`'s doc comment for the
 * IP-extraction caveat.
 *
 * ## M3 fix — email is not org-scoped for login purposes (docs/review-report.md)
 * The schema's `@@unique([organizationId, email])` constraint deliberately allows the same
 * email to exist in two different organizations, but sign-in takes only email+password with
 * no org selector. Previously `findFirst` silently picked whichever matching row came first
 * (order-dependent, non-deterministic) — a real bug if the same email is ever legitimately
 * registered in two orgs (invite-only signup doesn't prevent an admin from inviting the same
 * email to a second org). Fixed by treating email as required-globally-unique in practice
 * (the common one-org-per-email case, which is the only case this product's invite flow
 * intends to produce): if MORE THAN ONE `User` row matches the email, sign-in fails clearly
 * rather than guessing. This is a documented tradeoff, not a full fix — the real fix is
 * either an org-selector UI or a DB-level global-unique-email constraint.
 */
export async function verifyCredentials(
  rawCredentials: unknown,
  request: Request,
): Promise<AuthorizedCredentialsUser | null> {
  const parsed = credentialsSchema.safeParse(rawCredentials);
  if (!parsed.success) {
    return null;
  }
  const { email, password } = parsed.data;

  const rateLimitKey = `${getClientIp(request)}:${email}`;
  const rateLimit = authRateLimiter.check(rateLimitKey);
  if (!rateLimit.allowed) {
    logger.warn({ email }, "Sign-in rate limit exceeded");
    return null;
  }

  const matches = await prisma.user.findMany({ where: { email } });
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    // M3: same email exists in multiple orgs — fail clearly instead of picking arbitrarily.
    logger.warn({ email, matchCount: matches.length }, "Sign-in blocked: multiple accounts share this email across organizations");
    return null;
  }
  const user = matches[0];
  if (!user.passwordHash) {
    return null;
  }
  if (user.deactivatedAt) {
    // H3: a deactivated user cannot sign in via Credentials. Note: this only blocks NEW
    // sign-ins — it does not invalidate an already-issued JWT session (this app's JWT
    // strategy doesn't re-check the DB per request); see deactivateUser's doc comment for
    // this documented limitation.
    return null;
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    organizationId: user.organizationId,
    role: user.role,
  };
}
