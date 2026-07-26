/**
 * Contacts search/filter controls — Phase 7 ("List with search/filter (by channel,
 * language, archived status)"). Same plain-`<form method="get">` pattern as the inbox
 * filters (see inbox/filters-form.tsx) — URL search params, no client-side state.
 */
import Link from "next/link";
import type { ChannelType } from "@prisma/client";
import { channelLabel } from "@/components/channel-icon";

export function ContactsFiltersForm({
  current,
  channels,
  languages,
}: {
  current: { q?: string; channel?: string; language?: string; archived?: string };
  channels: ChannelType[];
  languages: string[];
}) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex min-w-[180px] flex-1 flex-col gap-1">
        <label htmlFor="contacts-search" className="text-xs font-medium text-muted">
          Search
        </label>
        <input
          id="contacts-search"
          name="q"
          type="search"
          defaultValue={current.q ?? ""}
          placeholder="Name, phone, or email"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="contacts-channel" className="text-xs font-medium text-muted">
          Channel
        </label>
        <select
          id="contacts-channel"
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
        <label htmlFor="contacts-language" className="text-xs font-medium text-muted">
          Language
        </label>
        <select
          id="contacts-language"
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
        <label htmlFor="contacts-archived" className="text-xs font-medium text-muted">
          Status
        </label>
        <select
          id="contacts-archived"
          name="archived"
          defaultValue={current.archived ?? "active"}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All</option>
        </select>
      </div>

      <div className="flex gap-2">
        <button type="submit" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground">
          Apply filters
        </button>
        <Link href="/contacts" className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-background">
          Clear
        </Link>
      </div>
    </form>
  );
}
