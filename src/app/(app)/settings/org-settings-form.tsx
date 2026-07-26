"use client";

/**
 * Org settings form — Phase 7 ("org default language, translation provider display
 * (read-only ... env-driven), review-before-send default ..., data retention setting").
 * Wired to `getOrgSettings`/`updateOrgSettings` (`src/server/actions/settings.ts`),
 * Session+Role(Administrator+) — this page already redirects non-Administrators (see
 * `page.tsx`), so no extra `canEdit` prop is needed here.
 */
import { useEffect, useState, useTransition } from "react";
import { COMMON_LANGUAGES } from "@/lib/languages";
import { getOrgSettings, updateOrgSettings } from "@/server/actions/settings";

export function OrgSettingsForm() {
  const [loading, setLoading] = useState(true);
  const [defaultLanguage, setDefaultLanguage] = useState("en");
  const [translationProvider, setTranslationProvider] = useState("noop");
  const [reviewBeforeSendDefault, setReviewBeforeSendDefault] = useState(false);
  const [dataRetentionDays, setDataRetentionDays] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    getOrgSettings().then((result) => {
      if (result.ok) {
        setDefaultLanguage(result.data.defaultLanguage);
        setTranslationProvider(result.data.translationProvider);
        setReviewBeforeSendDefault(result.data.reviewBeforeSendDefault);
        setDataRetentionDays(result.data.dataRetentionDays != null ? String(result.data.dataRetentionDays) : "");
      } else {
        setError(result.message);
      }
      setLoading(false);
    });
  }, []);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateOrgSettings({
        defaultLanguage,
        reviewBeforeSendDefault,
        dataRetentionDays: dataRetentionDays.trim() ? Number(dataRetentionDays) : null,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSaved(true);
    });
  }

  if (loading) {
    return <p className="text-sm text-muted">Loading organization settings…</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <h2 className="text-lg font-semibold text-foreground">Organization settings</h2>

      <div className="flex flex-col gap-1 sm:max-w-xs">
        <label htmlFor="org-default-language" className="text-xs font-medium text-muted">
          Default language
        </label>
        <select
          id="org-default-language"
          value={defaultLanguage}
          onChange={(e) => setDefaultLanguage(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        >
          {COMMON_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted">Used as the final fallback in the language-priority chain (§3.4).</p>
      </div>

      <div className="flex flex-col gap-1 sm:max-w-xs">
        <span className="text-xs font-medium text-muted">Translation provider</span>
        <span className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-muted">
          {translationProvider} (set via TRANSLATION_PROVIDER env var)
        </span>
        <p className="text-xs text-muted">
          Read-only here — the active provider is chosen at deploy time, not per-organization.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={reviewBeforeSendDefault}
          onChange={(e) => setReviewBeforeSendDefault(e.target.checked)}
          className="h-4 w-4 rounded border-border"
        />
        Default new conversations to &ldquo;review translation before sending&rdquo;
      </label>
      <p className="-mt-2 text-xs text-muted">
        Individual agents can still toggle this per-message in the composer; this only sets the initial state.
      </p>

      <div className="flex flex-col gap-1 sm:max-w-xs">
        <label htmlFor="org-data-retention" className="text-xs font-medium text-muted">
          Data retention (days)
        </label>
        <input
          id="org-data-retention"
          type="number"
          min={1}
          max={3650}
          value={dataRetentionDays}
          onChange={(e) => setDataRetentionDays(e.target.value)}
          placeholder="Leave blank to keep forever"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
        <p className="text-xs text-muted">
          How long conversation/message history is kept before it&rsquo;s eligible for deletion. This MVP stores the
          setting only — automated enforcement/deletion is a documented future compliance item (see docs/
          implementation-plan.md §7).
        </p>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && <p className="text-sm text-success">Saved.</p>}
      <div>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}
