/**
 * Shared inbox — Phase 7. Server Component: reads filters from URL search params
 * (`?q=&channel=&language=&assignee=&status=&unread=`), fetches org-scoped conversations via
 * `conversationRepository.listForInbox`, and renders the list. No client-side state is
 * needed for filtering — see filters-form.tsx's doc comment.
 */
import type { ChannelType, ConversationStatus } from "@prisma/client";
import { auth } from "@/server/auth";
import { channelAccountRepository } from "@/server/repositories/channelAccountRepository";
import { contactRepository } from "@/server/repositories/contactRepository";
import { conversationRepository } from "@/server/repositories/conversationRepository";
import { teamRepository } from "@/server/repositories/teamRepository";
import { userRepository } from "@/server/repositories/userRepository";
import { ConversationRow } from "./conversation-row";
import { InboxFiltersForm } from "./filters-form";

const VALID_STATUSES: ConversationStatus[] = ["OPEN", "PENDING", "RESOLVED", "ARCHIVED"];

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  const organizationId = session!.user.organizationId;
  const params = await searchParams;

  const q = firstParam(params.q)?.trim() || undefined;
  const channelParam = firstParam(params.channel) || undefined;
  const language = firstParam(params.language) || undefined;
  const assigneeParam = firstParam(params.assignee) || undefined;
  const statusParam = firstParam(params.status) || undefined;
  const unread = firstParam(params.unread) === "1";

  const channel = channelParam && (channelParam as ChannelType);
  const status = statusParam && VALID_STATUSES.includes(statusParam as ConversationStatus) ? (statusParam as ConversationStatus) : undefined;

  let assignedUserId: string | undefined;
  let assignedTeamId: string | undefined;
  let unassigned = false;
  if (assigneeParam === "unassigned") {
    unassigned = true;
  } else if (assigneeParam?.startsWith("user:")) {
    assignedUserId = assigneeParam.slice("user:".length);
  } else if (assigneeParam?.startsWith("team:")) {
    assignedTeamId = assigneeParam.slice("team:".length);
  }

  const [conversations, channelAccounts, contacts, users, teams] = await Promise.all([
    conversationRepository.listForInbox(organizationId, {
      channel: channel || undefined,
      language,
      assignedUserId,
      assignedTeamId,
      unassigned,
      status,
      search: q,
      unreadOnly: unread,
    }),
    channelAccountRepository.listByOrg(organizationId),
    contactRepository.listByOrg(organizationId, { includeArchived: true }),
    userRepository.listByOrg(organizationId),
    teamRepository.listByOrg(organizationId),
  ]);

  const availableChannels = Array.from(new Set(channelAccounts.map((c) => c.channelType)));
  const availableLanguages = Array.from(
    new Set(contacts.flatMap((c) => [c.preferredLanguage, c.detectedLanguage].filter((v): v is string => Boolean(v)))),
  ).sort();
  const assignees = [
    ...users.map((u) => ({ id: u.id, label: u.name, kind: "user" as const })),
    ...teams.map((t) => ({ id: t.id, label: t.name, kind: "team" as const })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Inbox</h1>
        <span className="text-sm text-muted">
          {conversations.length} conversation{conversations.length === 1 ? "" : "s"}
        </span>
      </div>

      <InboxFiltersForm
        current={{ q, channel: channelParam, language, assignee: assigneeParam, status: statusParam, unread: unread ? "1" : undefined }}
        channels={availableChannels}
        languages={availableLanguages}
        assignees={assignees}
      />

      <div className="flex flex-col gap-2">
        {conversations.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
            No conversations match these filters.
          </p>
        )}
        {conversations.map((conversation) => (
          <ConversationRow key={conversation.id} conversation={conversation} />
        ))}
      </div>
    </div>
  );
}
