/**
 * Org-scoped repository pattern, per docs/implementation-plan.md §6.1. See
 * organizationRepository.ts for the full rationale. Every read/write here is scoped by
 * `organizationId` so a caller can never reach across tenants even if they guess another
 * org's user id.
 */
import type { Role } from "@prisma/client";
import { prisma } from "../db";
import { NotFoundError } from "../errors";
import { logger } from "../logger";

export const userRepository = {
  /** Find a user by id, scoped to an organization. Returns null if not found or wrong org. */
  async findByIdInOrg(organizationId: string, userId: string) {
    return prisma.user.findFirst({ where: { id: userId, organizationId } });
  },

  async findByIdInOrgOrThrow(organizationId: string, userId: string) {
    const user = await prisma.user.findFirst({ where: { id: userId, organizationId } });
    if (!user) {
      throw new NotFoundError("User not found.", { organizationId, userId });
    }
    return user;
  },

  /**
   * Find a user by email. NOT org-scoped by design — this is the one lookup that must
   * cross organizations, because sign-in happens before we know which org a session
   * belongs to (email is only unique per-organization, see the `@@unique([organizationId,
   * email])` constraint).
   *
   * M3 fix (docs/review-report.md): this used to be a bare `findFirst`, silently returning
   * an arbitrary match — order-dependent and non-deterministic — if the same email ever
   * existed in more than one organization. Used by the Auth.js Prisma adapter's
   * `getUserByEmail` override (the magic-link sign-in flow), so a silent wrong-org pick here
   * would authenticate someone into the wrong organization's account. Now: zero matches
   * returns `null` (unchanged); exactly one match returns it (unchanged, the common case);
   * MORE than one match throws instead of guessing — a documented tradeoff (this product
   * has no org-selector UI, so treats email as required-globally-unique in practice; the
   * real fix is either an org-selector UI or a DB-level global-unique-email constraint).
   */
  async findByEmail(email: string) {
    const matches = await prisma.user.findMany({ where: { email } });
    if (matches.length > 1) {
      logger.warn({ email, matchCount: matches.length }, "userRepository.findByEmail: multiple accounts share this email across organizations");
      throw new Error("Multiple accounts found for this email; contact support.");
    }
    return matches[0] ?? null;
  },

  async listByOrg(organizationId: string) {
    return prisma.user.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
  },

  async create(input: {
    organizationId: string;
    name: string;
    email: string;
    role?: Role;
    preferredLanguage?: string;
    passwordHash?: string | null;
  }) {
    return prisma.user.create({ data: input });
  },

  async updateRole(organizationId: string, userId: string, role: Role) {
    // Re-assert organizationId in the where clause so this can never update a user in a
    // different org even if `userId` were guessed/forged.
    const result = await prisma.user.updateMany({
      where: { id: userId, organizationId },
      data: { role },
    });
    if (result.count === 0) {
      throw new NotFoundError("User not found.", { organizationId, userId });
    }
    return userRepository.findByIdInOrgOrThrow(organizationId, userId);
  },
};
