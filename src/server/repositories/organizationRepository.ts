/**
 * Org-scoped repository pattern, per docs/implementation-plan.md §6.1.
 *
 * Phase 3 establishes the pattern with `organizationRepository` / `userRepository` only.
 * Full contact/conversation/message repositories are a Phase 5 deliverable and should
 * follow the exact same shape: every function takes the caller's `organizationId`
 * explicitly (never trusts an org id embedded in client input), and no bare
 * `prisma.<model>.find*` call reaching a Route Handler or Server Action bypasses this
 * layer — that discipline is what makes cross-tenant data leaks structurally hard to
 * introduce (see Phase 10's review pass).
 */
import { prisma } from "../db";
import { NotFoundError } from "../errors";

export const organizationRepository = {
  /** Find an organization by id. Returns null if not found (callers decide whether that's fatal). */
  async findById(organizationId: string) {
    return prisma.organization.findUnique({ where: { id: organizationId } });
  },

  /** Find an organization by id or throw NotFoundError — use when the org must exist. */
  async findByIdOrThrow(organizationId: string) {
    const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!organization) {
      throw new NotFoundError("Organization not found.", { organizationId });
    }
    return organization;
  },

  async create(input: { name: string; defaultLanguage?: string; timezone?: string }) {
    return prisma.organization.create({ data: input });
  },

  async updateSettings(
    organizationId: string,
    input: Partial<{
      name: string;
      defaultLanguage: string;
      timezone: string;
      reviewBeforeSendDefault: boolean;
      dataRetentionDays: number | null;
    }>,
  ) {
    // Scoped by id — the caller is responsible for verifying the session's organizationId
    // matches before calling this (there is only ever one organization to update: the
    // caller's own), which is what makes this "org-scoped" rather than a bare model call.
    return prisma.organization.update({ where: { id: organizationId }, data: input });
  },
};
