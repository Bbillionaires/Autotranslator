"use client";

/**
 * Assignment + status + language-override + high-risk controls — Phase 7. All four map to
 * dedicated Server Actions in `src/server/actions/conversations.ts`, each independently
 * Session+Role(Agent+)-gated server-side (this component's `canManage` prop only controls
 * whether the *controls* render — hiding them is a UX nicety, not the security boundary; the
 * server-side `requireRole` check in each action is what actually enforces it, per
 * docs/implementation-plan.md §6.2).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ConversationStatus } from "@prisma/client";
import { COMMON_LANGUAGES } from "@/lib/languages";
import { assignConversation, changeConversationStatus, setConversationHighRisk, setConversationLanguageOverride } from "@/server/actions/conversations";

export function AssignmentPanel({
  conversationId,
  status,
  highRisk,
  assignedUserId,
  assignedTeamId,
  languageOverride,
  users,
  teams,
  canManage,
}: {
  conversationId: string;
  status: ConversationStatus;
  highRisk: boolean;
  assignedUserId: string | null;
  assignedTeamId: string | null;
  languageOverride: string | null;
  users: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
  canManage: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const assigneeValue = assignedUserId ? `user:${assignedUserId}` : assignedTeamId ? `team:${assignedTeamId}` : "";

  function handleAssigneeChange(value: string) {
    setError(null);
    startTransition(async () => {
      const [kind, id] = value.split(":");
      const result = await assignConversation({
        conversationId,
        assignedUserId: kind === "user" ? id : null,
        assignedTeamId: kind === "team" ? id : null,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  function handleStatusChange(value: ConversationStatus) {
    setError(null);
    startTransition(async () => {
      const result = await changeConversationStatus({ conversationId, status: value });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  function handleLanguageOverrideChange(value: string) {
    setError(null);
    startTransition(async () => {
      const result = await setConversationLanguageOverride({ conversationId, languageOverride: value || null });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  function handleHighRiskChange(value: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setConversationHighRisk({ conversationId, highRisk: value });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  if (!canManage) {
    return (
      <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-sm">
        <h2 className="text-sm font-semibold text-foreground">Conversation</h2>
        <p className="text-muted">Status: {status}</p>
        <p className="text-muted">
          {assignedUserId || assignedTeamId ? "Assigned" : "Unassigned"} · You have read-only access.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-foreground">Conversation</h2>

      <div className="flex flex-col gap-1">
        <label htmlFor="assignment-status" className="text-xs font-medium text-muted">
          Status
        </label>
        <select
          id="assignment-status"
          value={status}
          disabled={isPending}
          onChange={(e) => handleStatusChange(e.target.value as ConversationStatus)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="OPEN">Open</option>
          <option value="PENDING">Pending</option>
          <option value="RESOLVED">Resolved</option>
          <option value="ARCHIVED">Archived</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="assignment-assignee" className="text-xs font-medium text-muted">
          Assigned to
        </label>
        <select
          id="assignment-assignee"
          value={assigneeValue}
          disabled={isPending}
          onChange={(e) => handleAssigneeChange(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="">Unassigned</option>
          <optgroup label="Users">
            {users.map((u) => (
              <option key={u.id} value={`user:${u.id}`}>
                {u.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Teams">
            {teams.map((t) => (
              <option key={t.id} value={`team:${t.id}`}>
                {t.name}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="assignment-language-override" className="text-xs font-medium text-muted">
          Language override
        </label>
        <select
          id="assignment-language-override"
          value={languageOverride ?? ""}
          disabled={isPending}
          onChange={(e) => handleLanguageOverrideChange(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="">Auto (contact preference / org default)</option>
          {COMMON_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={highRisk}
          disabled={isPending}
          onChange={(e) => handleHighRiskChange(e.target.checked)}
          className="h-4 w-4 rounded border-border"
        />
        Mark as high-risk conversation
      </label>
      <p className="text-xs text-muted">
        High-risk conversations show a persistent warning that machine translation should not be relied on for
        medical, legal, financial, or emergency communications.
      </p>

      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}
