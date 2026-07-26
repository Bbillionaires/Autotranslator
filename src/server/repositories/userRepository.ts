/**
 * Org-scoped repository pattern, per docs/implementation-plan.md §6.1. See
 * organizationRepository.ts for the full rationale. Every read/write here is scoped by
 * `organizationId` so a caller can never reach across tenants even if they guess another
 * org's user id.
 */
import type { Role } from "@prisma/client";
import { prisma } from "../db";
import { NotFoundError } from "../errors";

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
   * email])` constraint, so in the rare case of the same email existing in multiple
   * orgs this returns the first match — acceptable for MVP since orgs are invite-only).
   */
  async findByEmail(email: string) {
    return prisma.user.findFirst({ where: { email } });
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
