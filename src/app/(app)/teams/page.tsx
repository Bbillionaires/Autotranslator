/**
 * Teams screen — Phase 7 ("Create team, add/remove members (with TeamRole), list teams and
 * members, assign conversations from here or link back to conversation assignment").
 * Conversation assignment itself is done from the conversation view
 * (`../inbox/[conversationId]/assignment-panel.tsx`) — this screen links back into the
 * inbox filtered by team, per "assign conversations from here or link back to conversation
 * assignment."
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { roleAtLeast } from "@/server/roles";
import { teamRepository } from "@/server/repositories/teamRepository";
import { userRepository } from "@/server/repositories/userRepository";
import { TeamCard } from "./team-card";
import { TeamCreateForm } from "./team-create-form";

export default async function TeamsPage() {
  const session = await auth();
  if (!session?.user || !roleAtLeast(session.user.role, "MANAGER")) {
    redirect("/inbox");
  }

  const organizationId = session.user.organizationId;
  const role = session.user.role;

  const [teams, users] = await Promise.all([
    teamRepository.listByOrg(organizationId),
    userRepository.listByOrg(organizationId),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-foreground">Teams</h1>

      <TeamCreateForm canCreate={roleAtLeast(role, "ADMINISTRATOR")} />

      <div className="grid gap-4 sm:grid-cols-2">
        {teams.map((team) => (
          <div key={team.id} className="flex flex-col gap-2">
            <TeamCard
              team={{
                id: team.id,
                name: team.name,
                members: team.members.map((m) => ({ userId: m.userId, name: m.user.name, role: m.role })),
                conversationCount: team._count.conversations,
              }}
              availableUsers={users.map((u) => ({ id: u.id, name: u.name }))}
              canManageMembers={roleAtLeast(role, "MANAGER")}
              canDelete={roleAtLeast(role, "ADMINISTRATOR")}
            />
            <Link href={`/inbox?assignee=team:${team.id}`} className="self-start text-xs font-medium text-accent hover:underline">
              View {team.name}&rsquo;s assigned conversations →
            </Link>
          </div>
        ))}
        {teams.length === 0 && <p className="text-sm text-muted">No teams yet.</p>}
      </div>
    </div>
  );
}
