/**
 * Contact detail — Phase 7 ("view connected channels (ContactChannelIdentity rows), view
 * conversation history (link into conversations), archive action").
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { roleAtLeast } from "@/server/roles";
import { contactRepository } from "@/server/repositories/contactRepository";
import { NotFoundError } from "@/server/errors";
import { ChannelIcon } from "@/components/channel-icon";
import { languageLabel } from "@/lib/languages";
import { ArchiveContactButton } from "./archive-button";
import { ContactEditForm } from "./contact-edit-form";
import { ReassignIdentityButton } from "./reassign-identity-button";

export default async function ContactDetailPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params;
  const session = await auth();
  // Per-page guard, independent of `(app)/layout.tsx`'s own check — see inbox/page.tsx's
  // identical comment for why a layout-level redirect alone isn't sufficient here.
  if (!session?.user) {
    redirect("/sign-in");
  }
  const organizationId = session.user.organizationId;
  const role = session.user.role;

  let contact;
  try {
    contact = await contactRepository.findByIdWithDetails(organizationId, contactId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      notFound();
    }
    throw error;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Link href="/contacts" className="text-sm text-accent hover:underline">
          ← Back to contacts
        </Link>
        <ArchiveContactButton contactId={contact.id} archived={Boolean(contact.archivedAt)} canArchive={roleAtLeast(role, "MANAGER")} />
      </div>

      {contact.archivedAt && (
        <p className="rounded-lg border border-border bg-muted/10 px-3 py-2 text-sm text-muted">
          This contact was archived on {new Date(contact.archivedAt).toLocaleDateString()}.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <section className="rounded-lg border border-border bg-surface p-4">
          <ContactEditForm contact={contact} canEdit={roleAtLeast(role, "AGENT")} />
          <p className="mt-3 text-sm text-muted">
            Preferred language: {contact.preferredLanguage ? languageLabel(contact.preferredLanguage) : "Not set"}
            {contact.detectedLanguage && !contact.preferredLanguage ? ` (detected: ${languageLabel(contact.detectedLanguage)})` : ""}
          </p>
        </section>

        <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
          <h2 className="text-sm font-semibold text-foreground">Connected channels</h2>
          <ul className="flex flex-col gap-2">
            {contact.identities.map((identity) => (
              <li key={identity.id} className="flex flex-wrap items-center gap-2 text-sm">
                <ChannelIcon channel={identity.channelAccount.channelType} />
                <span className="text-foreground">{identity.externalUsername ?? identity.externalContactId}</span>
                <ReassignIdentityButton contactChannelIdentityId={identity.id} canReassign={roleAtLeast(role, "MANAGER")} />
              </li>
            ))}
            {contact.identities.length === 0 && <li className="text-sm text-muted">No connected channels.</li>}
          </ul>
        </section>
      </div>

      <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-foreground">Conversation history</h2>
        {contact.conversations.length === 0 && <p className="text-sm text-muted">No conversations yet.</p>}
        <ul className="flex flex-col gap-2">
          {contact.conversations.map((conversation) => (
            <li key={conversation.id}>
              <Link
                href={`/inbox/${conversation.id}`}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm hover:bg-background"
              >
                <span className="flex items-center gap-2">
                  <ChannelIcon channel={conversation.channelAccount.channelType} />
                  {conversation.channelAccount.displayName}
                </span>
                <span className="text-xs text-muted">{conversation.status}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
