/**
 * Org-scoped repository for `Team`/`TeamMember`, per docs/implementation-plan.md §6.1. No
 * Team repository existed before Phase 7 — Phase 5/6 only needed `assignedTeamId` on
 * `Conversation` (see conversationRepository.assign), never team CRUD itself. This is the
 * missing piece the Phase 7 Teams screen needs (create team, add/remove members, list).
 */
import type { TeamRole } from "@prisma/client";
import { prisma } from "../db";
import type { PrismaClientOrTx } from "../db";
import { ConflictError, NotFoundError } from "../errors";

export const teamRepository = {
  async findByIdInOrg(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    return client.team.findFirst({ where: { id, organizationId } });
  },

  async findByIdInOrgOrThrow(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const team = await client.team.findFirst({ where: { id, organizationId } });
    if (!team) {
      throw new NotFoundError("Team not found.", { organizationId, id });
    }
    return team;
  },

  async listByOrg(organizationId: string, client: PrismaClientOrTx = prisma) {
    return client.team.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      include: {
        members: { include: { user: true }, orderBy: { createdAt: "asc" } },
        _count: { select: { conversations: true } },
      },
    });
  },

  async findByIdWithMembers(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const team = await client.team.findFirst({
      where: { id, organizationId },
      include: { members: { include: { user: true }, orderBy: { createdAt: "asc" } } },
    });
    if (!team) {
      throw new NotFoundError("Team not found.", { organizationId, id });
    }
    return team;
  },

  async create(organizationId: string, name: string, client: PrismaClientOrTx = prisma) {
    return client.team.create({ data: { organizationId, name } });
  },

  async delete(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const result = await client.team.deleteMany({ where: { id, organizationId } });
    if (result.count === 0) {
      throw new NotFoundError("Team not found.", { organizationId, id });
    }
  },

  /**
   * Adds a user to a team. Verifies both the team and the user belong to the caller's org
   * before writing (defense-in-depth, same discipline as
   * `contactChannelIdentityRepository.create`) so a forged `userId` from another org can
   * never be linked in.
   */
  async addMember(
    organizationId: string,
    teamId: string,
    userId: string,
    role: TeamRole = "MEMBER",
    client: PrismaClientOrTx = prisma,
  ) {
    const [team, user] = await Promise.all([
      client.team.findFirst({ where: { id: teamId, organizationId }, select: { id: true } }),
      client.user.findFirst({ where: { id: userId, organizationId }, select: { id: true } }),
    ]);
    if (!team) {
      throw new NotFoundError("Team not found.", { organizationId, teamId });
    }
    if (!user) {
      throw new NotFoundError("User not found.", { organizationId, userId });
    }

    const existing = await client.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
    if (existing) {
      throw new ConflictError("This user is already a member of the team.", { teamId, userId });
    }

    return client.teamMember.create({ data: { teamId, userId, role } });
  },

  async removeMember(organizationId: string, teamId: string, userId: string, client: PrismaClientOrTx = prisma) {
    const team = await client.team.findFirst({ where: { id: teamId, organizationId }, select: { id: true } });
    if (!team) {
      throw new NotFoundError("Team not found.", { organizationId, teamId });
    }
    const result = await client.teamMember.deleteMany({ where: { teamId, userId } });
    if (result.count === 0) {
      throw new NotFoundError("Team membership not found.", { organizationId, teamId, userId });
    }
  },
};
