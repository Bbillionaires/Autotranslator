"use server";

/**
 * Team-management Server Actions, per docs/implementation-plan.md §5 ("Admin | Server
 * Action `createTeam` / `updateTeam` / `addTeamMember` / `removeTeamMember` | Team
 * management | Session+Role(Manager+) for membership, Role(Administrator+) for
 * create/delete"). No Team repository or actions existed before Phase 7 — see
 * ../repositories/teamRepository.ts's doc comment for why.
 */
import { z } from "zod";
import type { Team, TeamMember, TeamRole } from "@prisma/client";
import { auth } from "../auth";
import { toSafeActionError } from "../errors";
import { auditLogRepository } from "../repositories/auditLogRepository";
import { teamRepository } from "../repositories/teamRepository";
import { requireRole } from "../roles";

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

const createTeamSchema = z.object({ name: z.string().min(1, "Team name is required.").max(200) });

export async function createTeam(input: z.infer<typeof createTeamSchema>): Promise<ActionResult<Team>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const parsed = createTeamSchema.parse(input);
    const team = await teamRepository.create(organizationId, parsed.name);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "team.created",
      entityType: "Team",
      entityId: team.id,
      metadata: { name: team.name },
    });

    return { ok: true, data: team };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const deleteTeamSchema = z.object({ teamId: z.string().min(1) });

export async function deleteTeam(input: z.infer<typeof deleteTeamSchema>): Promise<ActionResult<{ deleted: true }>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const parsed = deleteTeamSchema.parse(input);
    await teamRepository.delete(organizationId, parsed.teamId);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "team.deleted",
      entityType: "Team",
      entityId: parsed.teamId,
    });

    return { ok: true, data: { deleted: true } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const addTeamMemberSchema = z.object({
  teamId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(["LEAD", "MEMBER"]).optional(),
});

export async function addTeamMember(input: z.infer<typeof addTeamMemberSchema>): Promise<ActionResult<TeamMember>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "MANAGER");
    const organizationId = session!.user.organizationId;

    const parsed = addTeamMemberSchema.parse(input);
    const member = await teamRepository.addMember(
      organizationId,
      parsed.teamId,
      parsed.userId,
      (parsed.role ?? "MEMBER") as TeamRole,
    );

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "team.member_added",
      entityType: "Team",
      entityId: parsed.teamId,
      metadata: { userId: parsed.userId, role: parsed.role ?? "MEMBER" },
    });

    return { ok: true, data: member };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const removeTeamMemberSchema = z.object({ teamId: z.string().min(1), userId: z.string().min(1) });

export async function removeTeamMember(
  input: z.infer<typeof removeTeamMemberSchema>,
): Promise<ActionResult<{ removed: true }>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "MANAGER");
    const organizationId = session!.user.organizationId;

    const parsed = removeTeamMemberSchema.parse(input);
    await teamRepository.removeMember(organizationId, parsed.teamId, parsed.userId);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "team.member_removed",
      entityType: "Team",
      entityId: parsed.teamId,
      metadata: { userId: parsed.userId },
    });

    return { ok: true, data: { removed: true } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
