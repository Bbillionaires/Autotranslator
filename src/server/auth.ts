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
 */
import NextAuth from "next-auth";
import type { EmailConfig } from "@auth/core/providers/email";
import { PrismaAdapter } from "@auth/prisma-adapter";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "./db";
import { logger } from "./logger";
import { userRepository } from "./repositories/userRepository";
import type { Role } from "@prisma/client";
import "./auth.types";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

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
// `findFirst`-based lookup (see userRepository.findByEmail for the "not org-scoped by
// design" rationale) — every other adapter method already keys off a genuinely unique
// column (id, sessionToken, provider+providerAccountId, identifier+token) and needs no
// change. Note: self-service sign-up via an unrecognized email is not a supported flow
// (this product is invite-only per the plan) — `createUser` would fail against our schema
// (organizationId/name are required) if ever reached for a brand-new email; that's
// intentional, not a bug to fix here.
const prismaAdapter = PrismaAdapter(prisma);
const adapter = {
  ...prismaAdapter,
  getUserByEmail: (email: string) => userRepository.findByEmail(email),
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter,
  session: { strategy: "jwt" },
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
      async authorize(rawCredentials) {
        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) {
          return null;
        }
        const { email, password } = parsed.data;

        const user = await prisma.user.findFirst({ where: { email } });
        if (!user || !user.passwordHash) {
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
      },
    }),
    devConsoleEmailProvider(),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // `user` is only present on initial sign-in; persist the custom claims onto the
        // token so subsequent requests don't need a DB round trip to know org/role.
        token.userId = user.id;
        token.organizationId = (user as { organizationId?: string }).organizationId;
        token.role = (user as { role?: Role }).role;
      }
      return token;
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
