"use client";

/**
 * Archive-contact action — Phase 7 ("archive action (Session+Role(Manager+))"). Hidden for
 * roles below Manager (`canArchive` prop) as a UX nicety; `archiveContact` re-checks
 * server-side regardless, per docs/implementation-plan.md §6.2.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { archiveContact } from "@/server/actions/contacts";

export function ArchiveContactButton({ contactId, archived, canArchive }: { contactId: string; archived: boolean; canArchive: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!canArchive || archived) {
    return null;
  }

  function handleArchive() {
    setError(null);
    startTransition(async () => {
      const result = await archiveContact({ contactId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleArchive}
        disabled={isPending}
        className="rounded-md border border-danger/40 px-3 py-1.5 text-sm font-medium text-danger disabled:opacity-50"
      >
        {isPending ? "Archiving…" : "Archive contact"}
      </button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
