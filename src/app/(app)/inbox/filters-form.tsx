/**
 * Inbox filter controls, per the Phase 7 task brief ("search box, filters by channel/
 * language/assigned-teammate/status/unread"). Deliberately a plain `<form method="get">` —
 * no client component, no client-side state — so filters are URL search params
 * (`?channel=&language=&assignee=&status=&unread=`), shareable/bookmarkable, and work
 * without JavaScript (progressive enhancement): the browser itself builds the query string
 * on submit. `page.tsx` reads `searchParams` server-side and re-renders the list.
 */
import Link from "next/link";
import type { ChannelType } from "@prisma/client";
import { channelLabel } from "@/components/channel-icon";

export interface InboxFiltersFormProps {
  current: {
    q?: string;
    channel?: string;
    language?: string;
    assignee?: string;
    status?: string;
    unread?: string;
  };
  channels: ChannelType[];
  languages: string[];
  assignees: Array<{ id: string; label: string; kind: "user" | "team" }>;
}

export function InboxFiltersForm({ current, channels, languages, assignees }: InboxFiltersFormProps) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex min-w-[180px] flex-1 flex-col gap-1">
        <label htmlFor="inbox-search" className="text-xs font-medium text-muted">
          Search
        </label>
        <input
          id="inbox-search"
          name="q"
          type="search"
          defaultValue={current.q ?? ""}
          placeholder="Contact name, phone, or message text"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="inbox-channel" className="text-xs font-medium text-muted">
          Channel
        </label>
        <select
          id="inbox-channel"
          name="channel"
          defaultValue={current.channel ?? ""}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="">All channels</option>
          {channels.map((channel) => (
            <option key={channel} value={channel}>
              {channelLabel(channel)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="inbox-language" className="text-xs font-medium text-muted">
          Language
        </label>
        <select
          id="inbox-language"
          name="language"
          defaultValue={current.language ?? ""}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="">All languages</option>
          {languages.map((language) => (
            <option key={language} value={language}>
              {language}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="inbox-assignee" className="text-xs font-medium text-muted">
          Assigned to
        </label>
        <select
          id="inbox-assignee"
          name="assignee"
          defaultValue={current.assignee ?? ""}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="">Anyone</option>
          <option value="unassigned">Unassigned</option>
          {assignees.map((assignee) => (
            <option key={`${assignee.kind}-${assignee.id}`} value={`${assignee.kind}:${assignee.id}`}>
              {assignee.kind === "team" ? `Team: ${assignee.label}` : assignee.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="inbox-status" className="text-xs font-medium text-muted">
          Status
        </label>
        <select
          id="inbox-status"
          name="status"
          defaultValue={current.status ?? ""}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="">Any status</option>
          <option value="OPEN">Open</option>
          <option value="PENDING">Pending</option>
          <option value="RESOLVED">Resolved</option>
          <option value="ARCHIVED">Archived</option>
        </select>
      </div>

      <div className="flex items-center gap-2 pb-1.5">
        <input
          id="inbox-unread"
          name="unread"
          type="checkbox"
          value="1"
          defaultChecked={current.unread === "1"}
          className="h-4 w-4 rounded border-border"
        />
        <label htmlFor="inbox-unread" className="text-sm text-foreground">
          Unread only
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
        >
          Apply filters
        </button>
        <Link
          href="/inbox"
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-background"
        >
          Clear
        </Link>
      </div>
    </form>
  );
}
