/**
 * Contacts screen — Phase 7. Server Component: reads `?q=&channel=&language=&archived=`
 * from the URL (same shareable-filters pattern as the inbox), lists org-scoped contacts via
 * `contactRepository.listForContactsPage`, and renders a create form + the list.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ChannelType } from "@prisma/client";
import { auth } from "@/server/auth";
import { roleAtLeast } from "@/server/roles";
import { channelAccountRepository } from "@/server/repositories/channelAccountRepository";
import { contactRepository } from "@/server/repositories/contactRepository";
import { ChannelIcon } from "@/components/channel-icon";
import { languageLabel } from "@/lib/languages";
import { ContactCreateForm } from "./contact-create-form";
import { ContactsFiltersForm } from "./filters-form";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  // Per-page guard, independent of `(app)/layout.tsx`'s own check — see inbox/page.tsx's
  // identical comment for why a layout-level redirect alone isn't sufficient here.
  if (!session?.user) {
    redirect("/sign-in");
  }
  const organizationId = session.user.organizationId;
  const role = session.user.role;
  const params = await searchParams;

  const q = firstParam(params.q)?.trim() || undefined;
  const channelParam = firstParam(params.channel) || undefined;
  const language = firstParam(params.language) || undefined;
  const archivedParam = (firstParam(params.archived) as "active" | "archived" | "all" | undefined) ?? "active";

  const [contacts, channelAccounts, allContacts] = await Promise.all([
    contactRepository.listForContactsPage(organizationId, {
      search: q,
      channel: (channelParam as ChannelType) || undefined,
      language,
      archived: archivedParam,
    }),
    channelAccountRepository.listByOrg(organizationId),
    contactRepository.listByOrg(organizationId, { includeArchived: true }),
  ]);

  const availableChannels = Array.from(new Set(channelAccounts.map((c) => c.channelType)));
  const availableLanguages = Array.from(
    new Set(allContacts.flatMap((c) => [c.preferredLanguage, c.detectedLanguage].filter((v): v is string => Boolean(v)))),
  ).sort();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Contacts</h1>
        <span className="text-sm text-muted">
          {contacts.length} contact{contacts.length === 1 ? "" : "s"}
        </span>
      </div>

      <ContactCreateForm canCreate={roleAtLeast(role, "AGENT")} />

      <ContactsFiltersForm
        current={{ q, channel: channelParam, language, archived: archivedParam }}
        channels={availableChannels}
        languages={availableLanguages}
      />

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border text-xs uppercase text-muted">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Language</th>
              <th className="px-3 py-2">Channels</th>
              <th className="px-3 py-2">Conversations</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {contacts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted">
                  No contacts match these filters.
                </td>
              </tr>
            )}
            {contacts.map((contact) => (
              <tr key={contact.id} className="border-b border-border last:border-0 hover:bg-background">
                <td className="px-3 py-2">
                  <Link href={`/contacts/${contact.id}`} className="font-medium text-accent hover:underline">
                    {contact.displayName}
                  </Link>
                  {contact.phoneNumber && <div className="text-xs text-muted">{contact.phoneNumber}</div>}
                </td>
                <td className="px-3 py-2 text-muted">{languageLabel(contact.preferredLanguage ?? contact.detectedLanguage)}</td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    {Array.from(new Set(contact.identities.map((i) => i.channelAccount.channelType))).map((channel) => (
                      <ChannelIcon key={channel} channel={channel} />
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted">{contact._count.conversations}</td>
                <td className="px-3 py-2">
                  {contact.archivedAt ? (
                    <span className="rounded-full bg-muted/10 px-2 py-0.5 text-xs font-medium text-muted">Archived</span>
                  ) : (
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">Active</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
