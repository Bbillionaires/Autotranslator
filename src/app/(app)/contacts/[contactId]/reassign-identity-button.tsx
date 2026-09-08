"use client";

/**
 * "Reassign this identity" control — M4 fix (docs/review-report.md), the UI entry point for
 * the `connectChannelIdentity` Server Action ("Link a `ContactChannelIdentity` to a contact
 * (merge duplicate identities) | Session+Role(Manager+)"). Lets a Manager+ move a connected
 * channel (e.g. a Telegram identity that first messaged as a duplicate `Contact`) onto a
 * different contact's record by pasting the target contact's id — this MVP has no
 * contact-search/autocomplete UI yet, so the id (visible in that other contact's own detail
 * page URL) is the simplest input that doesn't require building one just for this control.
 * Hidden for roles below Manager (`canReassign` prop), matching `ArchiveContactButton`'s
 * precedent; `connectChannelIdentity` re-checks the role server-side regardless.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { connectChannelIdentity } from "@/server/actions/contacts";

export function ReassignIdentityButton({
  contactChannelIdentityId,
  canReassign,
}: {
  contactChannelIdentityId: string;
  canReassign: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targetContactId, setTargetContactId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!canReassign) {
    return null;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-accent hover:underline"
      >
        Reassign
      </button>
    );
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await connectChannelIdentity({ contactChannelIdentityId, contactId: targetContactId.trim() });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      setTargetContactId("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-wrap items-center gap-1">
      <input
        value={targetContactId}
        onChange={(e) => setTargetContactId(e.target.value)}
        placeholder="Target contact ID"
        aria-label="Target contact ID"
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
      />
      <button
        type="submit"
        disabled={isPending || targetContactId.trim().length === 0}
        className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground disabled:opacity-50"
      >
        {isPending ? "Moving…" : "Move here"}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
        className="rounded-md border border-border px-2 py-1 text-xs text-foreground"
      >
        Cancel
      </button>
      {error && <p className="w-full text-xs text-danger">{error}</p>}
    </form>
  );
}
