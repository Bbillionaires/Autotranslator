"use client";

/**
 * Create-team form — Phase 7 ("create team ... role-gated actions"). `createTeam` itself is
 * Session+Role(Administrator+); `canCreate` only decides whether to render.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createTeam } from "@/server/actions/teams";

export function TeamCreateForm({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!canCreate) {
    return null;
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await createTeam({ name });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setName("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="new-team-name" className="text-xs font-medium text-muted">
          New team name
        </label>
        <input
          id="new-team-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
      </div>
      <button
        type="submit"
        disabled={isPending || !name.trim()}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
      >
        {isPending ? "Creating…" : "Create team"}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </form>
  );
}
