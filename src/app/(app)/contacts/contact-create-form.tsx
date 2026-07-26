"use client";

/**
 * Create-contact form — Phase 7 ("create/edit forms (Server Actions, Zod-validated)").
 * Session+Role(Agent+) per docs/implementation-plan.md §5; `createContact` itself re-checks
 * server-side, this component only decides whether to render (`canCreate`).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { COMMON_LANGUAGES } from "@/lib/languages";
import { createContact } from "@/server/actions/contacts";

export function ContactCreateForm({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [email, setEmail] = useState("");
  const [preferredLanguage, setPreferredLanguage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!canCreate) {
    return null;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
      >
        + New contact
      </button>
    );
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createContact({
        displayName,
        phoneNumber: phoneNumber || undefined,
        email: email || undefined,
        preferredLanguage: preferredLanguage || undefined,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setOpen(false);
      setDisplayName("");
      setPhoneNumber("");
      setEmail("");
      setPreferredLanguage("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-foreground">New contact</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="new-contact-name" className="text-xs font-medium text-muted">
            Name *
          </label>
          <input
            id="new-contact-name"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-contact-phone" className="text-xs font-medium text-muted">
            Phone
          </label>
          <input
            id="new-contact-phone"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-contact-email" className="text-xs font-medium text-muted">
            Email
          </label>
          <input
            id="new-contact-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-contact-language" className="text-xs font-medium text-muted">
            Preferred language
          </label>
          <select
            id="new-contact-language"
            value={preferredLanguage}
            onChange={(e) => setPreferredLanguage(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">Unknown (detect from messages)</option>
            {COMMON_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending || !displayName.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {isPending ? "Creating…" : "Create contact"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground">
          Cancel
        </button>
      </div>
    </form>
  );
}
