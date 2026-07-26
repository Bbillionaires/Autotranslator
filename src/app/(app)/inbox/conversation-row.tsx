import Link from "next/link";
import type { Contact, ChannelAccount, ConversationStatus, Message, Team, User } from "@prisma/client";
import { ChannelIcon } from "@/components/channel-icon";
import { DeliveryStatusBadge } from "@/components/delivery-status-badge";
import { languageLabel } from "@/lib/languages";

export interface InboxRowData {
  id: string;
  status: ConversationStatus;
  highRisk: boolean;
  contact: Contact;
  channelAccount: ChannelAccount;
  assignedUser: User | null;
  assignedTeam: Team | null;
  lastMessage: Message | null;
  unreadCount: number;
}

const STATUS_LABEL: Record<ConversationStatus, string> = {
  OPEN: "Open",
  PENDING: "Pending",
  RESOLVED: "Resolved",
  ARCHIVED: "Archived",
};

export function ConversationRow({ conversation }: { conversation: InboxRowData }) {
  const { contact, lastMessage, unreadCount } = conversation;
  const resolvedLanguage = contact.preferredLanguage ?? contact.detectedLanguage;

  return (
    <Link
      href={`/inbox/${conversation.id}`}
      className={`flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 transition-colors hover:bg-background sm:flex-row sm:items-center sm:gap-4 ${
        unreadCount > 0 ? "border-l-4 border-l-accent" : ""
      }`}
    >
      <div className="flex items-center gap-3 sm:w-56 sm:flex-shrink-0">
        <ChannelIcon channel={conversation.channelAccount.channelType} />
        <div className="flex flex-col">
          <span className="font-medium text-foreground">{contact.displayName}</span>
          <span className="text-xs text-muted">{languageLabel(resolvedLanguage)}</span>
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-muted">
          {lastMessage
            ? `${lastMessage.direction === "OUTBOUND" ? (lastMessage.isInternalNote ? "Note: " : "You: ") : ""}${
                lastMessage.translatedText ?? lastMessage.originalText
              }`
            : "No messages yet"}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs sm:w-72 sm:flex-shrink-0 sm:justify-end">
        <span className="rounded-full bg-background px-2 py-0.5 font-medium text-muted">
          {STATUS_LABEL[conversation.status]}
        </span>
        {conversation.highRisk && (
          <span className="rounded-full bg-danger/10 px-2 py-0.5 font-medium text-danger" title="High-risk conversation">
            ⚠ High-risk
          </span>
        )}
        <span className="text-muted">
          {conversation.assignedTeam
            ? `Team: ${conversation.assignedTeam.name}`
            : conversation.assignedUser
              ? conversation.assignedUser.name
              : "Unassigned"}
        </span>
        {lastMessage && lastMessage.direction === "OUTBOUND" && <DeliveryStatusBadge status={lastMessage.status} />}
        {unreadCount > 0 && (
          <span
            className="rounded-full bg-accent px-2 py-0.5 font-semibold text-accent-foreground"
            aria-label={`${unreadCount} unread message${unreadCount === 1 ? "" : "s"}`}
          >
            {unreadCount} unread
          </span>
        )}
      </div>
    </Link>
  );
}
