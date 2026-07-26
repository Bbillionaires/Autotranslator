"use client";

/**
 * Inline edit form for a contact's name/phone/email/notes — Phase 7 ("create/edit forms").
 * Preferred-language editing lives in the conversation view's sidebar
 * (`../../inbox/[conversationId]/contact-sidebar.tsx`) via `setContactLanguage`; this form
 * covers the remaining editable fields via `updateContact`.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Contact } from "@prisma/client";
import { updateContact } from "@/server/actions/contacts";

export function ContactEditForm({ contact, canEdit }: { contact: Contact; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(contact.displayName);
  const [phoneNumber, setPhoneNumber] = useState(contact.phoneNumber ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!editing) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">{contact.displayName}</h2>
          {canEdit && (
            <button type="button" onClick={() => setEditing(true)} className="text-sm font-medium text-accent hover:underline">
              Edit
            </button>
          )}
        </div>
        {contact.phoneNumber && <p className="text-sm text-muted">Phone: {contact.phoneNumber}</p>}
        {contact.email && <p className="text-sm text-muted">Email: {contact.email}</p>}
        {contact.notes && <p className="whitespace-pre-wrap text-sm text-foreground">{contact.notes}</p>}
      </div>
    );
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updateContact({
        contactId: contact.id,
        displayName,
        phoneNumber: phoneNumber || null,
        email: email || null,
        notes: notes || null,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="edit-contact-name" className="text-xs font-medium text-muted">
          Name
        </label>
        <input
          id="edit-contact-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="edit-contact-phone" className="text-xs font-medium text-muted">
          Phone
        </label>
        <input
          id="edit-contact-phone"
          value={phoneNumber}
          onChange={(e) => setPhoneNumber(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="edit-contact-email" className="text-xs font-medium text-muted">
          Email
        </label>
        <input
          id="edit-contact-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="edit-contact-notes" className="text-xs font-medium text-muted">
          Notes
        </label>
        <textarea
          id="edit-contact-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          Save
        </button>
        <button type="button" onClick={() => setEditing(false)} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground">
          Cancel
        </button>
      </div>
    </form>
  );
}
