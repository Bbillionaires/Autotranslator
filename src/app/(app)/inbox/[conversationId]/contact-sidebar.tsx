"use client";

/**
 * Contact details sidebar — Phase 7 ("name, preferred language (editable inline via
 * `setContactLanguage`), connected channel identities, notes").
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ChannelAccount, Contact, ContactChannelIdentity } from "@prisma/client";
import { ChannelIcon } from "@/components/channel-icon";
import { COMMON_LANGUAGES, languageLabel } from "@/lib/languages";
import { setContactLanguage } from "@/server/actions/contacts";

type ContactWithIdentities = Contact & {
  identities: Array<ContactChannelIdentity & { channelAccount: ChannelAccount }>;
};

export function ContactSidebar({ contact, canEdit }: { contact: ContactWithIdentities; canEdit: boolean }) {
  const router = useRouter();
  const [editingLanguage, setEditingLanguage] = useState(false);
  const [language, setLanguage] = useState(contact.preferredLanguage ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSaveLanguage() {
    setError(null);
    startTransition(async () => {
      const result = await setContactLanguage({ contactId: contact.id, preferredLanguage: language });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setEditingLanguage(false);
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-foreground">Contact</h2>

      <div className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted">Name</span>
        <span className="text-foreground">{contact.displayName}</span>
      </div>

      {contact.phoneNumber && (
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted">Phone</span>
          <span className="text-foreground">{contact.phoneNumber}</span>
        </div>
      )}

      <div className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted">Preferred language</span>
        {!editingLanguage ? (
          <div className="flex items-center gap-2">
            <span className="text-foreground">
              {contact.preferredLanguage ? languageLabel(contact.preferredLanguage) : "Not set (using detected/org default)"}
            </span>
            {canEdit && (
              <button type="button" onClick={() => setEditingLanguage(true)} className="text-xs font-medium text-accent hover:underline">
                Edit
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label htmlFor="contact-language" className="sr-only">
              Preferred language
            </label>
            <select
              id="contact-language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
            >
              <option value="">— none —</option>
              {COMMON_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleSaveLanguage}
              disabled={isPending}
              className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground disabled:opacity-50"
            >
              Save
            </button>
            <button type="button" onClick={() => setEditingLanguage(false)} className="text-xs text-muted hover:underline">
              Cancel
            </button>
          </div>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted">Connected channels</span>
        <ul className="flex flex-col gap-1">
          {contact.identities.map((identity) => (
            <li key={identity.id} className="flex items-center gap-2 text-foreground">
              <ChannelIcon channel={identity.channelAccount.channelType} />
              <span className="text-xs">{identity.externalUsername ?? identity.externalContactId}</span>
            </li>
          ))}
        </ul>
      </div>

      {contact.notes && (
        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted">Notes</span>
          <p className="whitespace-pre-wrap text-foreground">{contact.notes}</p>
        </div>
      )}

      <a href={`/contacts/${contact.id}`} className="text-xs font-medium text-accent hover:underline">
        View full contact profile →
      </a>
    </section>
  );
}
