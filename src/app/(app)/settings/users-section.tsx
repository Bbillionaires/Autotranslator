"use client";

/**
 * User-management Settings UI — H3 fix (docs/review-report.md). Wired to
 * `src/server/actions/users.ts` (all Session+Role(Administrator+); this page is already
 * gated at Administrator+ in `page.tsx`, but the actions re-check independently
 * regardless). Lists every user (role, active/deactivated status), a role-change control, an
 * invite form (shows the one-time temporary password — see `users.ts`'s doc comment for why
 * there's no real email-sending here yet), and a deactivate button per user.
 */
import { useEffect, useState, useTransition } from "react";
import {
  deactivateUser,
  inviteUser,
  listUsers,
  updateUserRole,
  type AdminUserView,
} from "@/server/actions/users";

const ROLES = ["OWNER", "ADMINISTRATOR", "MANAGER", "AGENT", "VIEWER"] as const;

export function UsersSection() {
  const [users, setUsers] = useState<AdminUserView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("AGENT");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [issuedInvite, setIssuedInvite] = useState<{ email: string; temporaryPassword: string } | null>(null);

  const [rowError, setRowError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      const result = await listUsers();
      if (result.ok) {
        setUsers(result.data);
        setListError(null);
      } else {
        setListError(result.message);
      }
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleInvite(event: React.FormEvent) {
    event.preventDefault();
    setInviteError(null);
    setIssuedInvite(null);
    startTransition(async () => {
      const result = await inviteUser({ name, email, role });
      if (!result.ok) {
        setInviteError(result.message);
        return;
      }
      setIssuedInvite({ email: result.data.user.email, temporaryPassword: result.data.temporaryPassword });
      setName("");
      setEmail("");
      setRole("AGENT");
      refresh();
    });
  }

  function handleRoleChange(userId: string, newRole: (typeof ROLES)[number]) {
    setRowError(null);
    startTransition(async () => {
      const result = await updateUserRole({ userId, role: newRole });
      if (!result.ok) {
        setRowError(result.message);
        return;
      }
      refresh();
    });
  }

  function handleDeactivate(userId: string) {
    setRowError(null);
    startTransition(async () => {
      const result = await deactivateUser({ userId });
      if (!result.ok) {
        setRowError(result.message);
        return;
      }
      refresh();
    });
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <h2 className="text-lg font-semibold text-foreground">Users</h2>

      {listError && <p className="text-sm text-danger">{listError}</p>}
      {rowError && <p className="text-sm text-danger">{rowError}</p>}

      <ul className="flex flex-col gap-2">
        {(users ?? []).map((user) => (
          <li
            key={user.id}
            className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <span className="font-medium text-foreground">{user.name}</span>{" "}
              <span className="text-xs text-muted">({user.email})</span>
              {user.deactivatedAt && (
                <span className="ml-2 rounded-full bg-muted/10 px-2 py-0.5 text-xs font-medium text-muted">Deactivated</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <select
                aria-label={`Role for ${user.name}`}
                value={user.role}
                disabled={isPending || Boolean(user.deactivatedAt)}
                onChange={(e) => handleRoleChange(user.id, e.target.value as (typeof ROLES)[number])}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              {!user.deactivatedAt && (
                <button
                  type="button"
                  onClick={() => handleDeactivate(user.id)}
                  disabled={isPending}
                  className="rounded-md border border-danger/40 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
                >
                  Deactivate
                </button>
              )}
            </div>
          </li>
        ))}
        {users && users.length === 0 && <li className="text-sm text-muted">No users yet.</li>}
      </ul>

      <form onSubmit={handleInvite} className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="invite-name" className="text-xs font-medium text-muted">
            Name
          </label>
          <input
            id="invite-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="invite-email" className="text-xs font-medium text-muted">
            Email
          </label>
          <input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="invite-role" className="text-xs font-medium text-muted">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {isPending ? "Inviting…" : "Invite user"}
          </button>
        </div>
        {inviteError && <p className="text-sm text-danger sm:col-span-2">{inviteError}</p>}
      </form>

      {issuedInvite && (
        <div className="flex flex-col gap-1 rounded-md border border-accent/40 bg-accent/10 p-3 text-sm text-foreground">
          <p className="font-medium">
            Temporary password for {issuedInvite.email} (shown once — relay it to the new user directly):
          </p>
          <code className="break-all rounded bg-background px-2 py-1 text-xs">{issuedInvite.temporaryPassword}</code>
          <p className="text-xs text-muted">
            There is no email-invite flow yet (this MVP has no email transport wired up — see
            src/server/actions/users.ts&rsquo;s doc comment). The new user can sign in with this email + password now.
          </p>
        </div>
      )}
    </section>
  );
}
