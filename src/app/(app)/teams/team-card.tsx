"use client";

/**
 * Single team card — Phase 7 ("add/remove members ... list teams and members"). Membership
 * changes are Session+Role(Manager+); team deletion is Session+Role(Administrator+), per
 * docs/implementation-plan.md §5. Both checks are re-verified server-side in
 * `src/server/actions/teams.ts`; `canManageMembers`/`canDelete` here only control rendering.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TeamRole } from "@prisma/client";
import { addTeamMember, deleteTeam, removeTeamMember } from "@/server/actions/teams";

export interface TeamCardData {
  id: string;
  name: string;
  members: Array<{ userId: string; name: string; role: TeamRole }>;
  conversationCount: number;
}

export function TeamCard({
  team,
  availableUsers,
  canManageMembers,
  canDelete,
}: {
  team: TeamCardData;
  availableUsers: Array<{ id: string; name: string }>;
  canManageMembers: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [selectedUserId, setSelectedUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const memberIds = new Set(team.members.map((m) => m.userId));
  const addableUsers = availableUsers.filter((u) => !memberIds.has(u.id));

  function handleAddMember() {
    if (!selectedUserId) return;
    setError(null);
    startTransition(async () => {
      const result = await addTeamMember({ teamId: team.id, userId: selectedUserId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSelectedUserId("");
      router.refresh();
    });
  }

  function handleRemoveMember(userId: string) {
    setError(null);
    startTransition(async () => {
      const result = await removeTeamMember({ teamId: team.id, userId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  function handleDeleteTeam() {
    setError(null);
    startTransition(async () => {
      const result = await deleteTeam({ teamId: team.id });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{team.name}</h2>
          <p className="text-xs text-muted">{team.conversationCount} assigned conversation(s)</p>
        </div>
        {canDelete && (
          <button
            type="button"
            onClick={handleDeleteTeam}
            disabled={isPending}
            className="rounded-md border border-danger/40 px-2 py-1 text-xs font-medium text-danger disabled:opacity-50"
          >
            Delete team
          </button>
        )}
      </div>

      <ul className="flex flex-col gap-1">
        {team.members.map((member) => (
          <li key={member.userId} className="flex items-center justify-between text-sm">
            <span className="text-foreground">
              {member.name} <span className="text-xs text-muted">({member.role})</span>
            </span>
            {canManageMembers && (
              <button
                type="button"
                onClick={() => handleRemoveMember(member.userId)}
                disabled={isPending}
                className="text-xs font-medium text-danger hover:underline disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </li>
        ))}
        {team.members.length === 0 && <li className="text-sm text-muted">No members yet.</li>}
      </ul>

      {canManageMembers && addableUsers.length > 0 && (
        <div className="flex items-center gap-2">
          <label htmlFor={`add-member-${team.id}`} className="sr-only">
            Add member to {team.name}
          </label>
          <select
            id={`add-member-${team.id}`}
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">Add a member…</option>
            {addableUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleAddMember}
            disabled={isPending || !selectedUserId}
            className="rounded-md bg-accent px-2 py-1.5 text-xs font-medium text-accent-foreground disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
