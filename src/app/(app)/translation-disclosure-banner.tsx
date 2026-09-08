"use client";

/**
 * General translation-quality disclosure banner — M2 fix (docs/review-report.md /
 * docs/test-report.md).
 *
 * §6.9 describes TWO distinct UI elements: (1) this one — a persistent, dismissible-but-
 * re-shown banner stating machine translation is imperfect, shown broadly (the app shell),
 * independent of any single conversation; and (2) the opt-in per-conversation
 * `HighRiskBanner` (`inbox/[conversationId]/high-risk-banner.tsx`), which layers a *stronger*
 * warning on top for conversations an agent has explicitly flagged. Only (2) existed before
 * this fix — this component is (1), and is additive, not a replacement: both can be visible
 * at once (this one in the app shell, the high-risk one inside a flagged conversation).
 *
 * ## "Dismissible but periodically re-shown" — the exact policy (documented per the task)
 * Dismissal is remembered in `localStorage` (per-browser, not per-account — there is no
 * server-side "banner dismissed" field on `User`/`Session`, and adding one purely for a
 * cosmetic disclosure banner would be disproportionate) as a timestamp, not a boolean.
 * Chosen re-show window: **7 days** since the last dismissal — long enough not to nag on
 * every page load (the whole point of "dismissible"), short enough that the disclosure
 * genuinely resurfaces on a realistic cadence for an active user, rather than being
 * dismissed once and never seen again for the life of the browser profile. A stale/missing/
 * corrupt localStorage value (private browsing, cleared site data, a different browser or
 * device, or simply `localStorage` throwing — Safari private mode, embedded webviews) is
 * treated the same as "never dismissed": the banner shows. This also means it naturally
 * re-appears "on next sign-in" from a fresh browser/device, satisfying that half of the task
 * brief's suggested policy without needing separate sign-in-tracking logic.
 */
import { useEffect, useState } from "react";

const STORAGE_KEY = "autotranslator:translationDisclosureDismissedAt";
const RESHOW_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function readDismissedAt(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // localStorage unavailable (private mode, blocked site data, etc.) — fail open (show it).
    return null;
  }
}

function writeDismissedAt(timestamp: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(timestamp));
  } catch {
    // Best-effort only — if it can't be persisted, the banner will simply show again next
    // load, which is a safe/acceptable failure mode for a disclosure notice.
  }
}

export function TranslationDisclosureBanner() {
  // Starts hidden (not "unknown") so server-rendered/first-paint markup never shows it —
  // localStorage isn't available during SSR, and showing-then-hiding on hydration would be a
  // visible flash. It's decided for real in the effect below, which only runs client-side.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Deferred a tick (rather than calling `setVisible` synchronously in the effect body)
    // per `react-hooks/set-state-in-effect` — this mount check is a one-time read of an
    // external store (localStorage), not a derived-state computation the render itself
    // should own, so the deferral is harmless here (one extra microtask, no visible delay).
    queueMicrotask(() => {
      if (cancelled) return;
      const dismissedAt = readDismissedAt();
      const shouldShow = dismissedAt === null || Date.now() - dismissedAt >= RESHOW_AFTER_MS;
      setVisible(shouldShow);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) {
    return null;
  }

  function handleDismiss() {
    writeDismissedAt(Date.now());
    setVisible(false);
  }

  return (
    <div
      role="note"
      className="mx-auto flex w-full max-w-6xl items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-300"
    >
      <span aria-hidden="true">ℹ</span>
      <p className="flex-1">
        Machine translation can make mistakes. Do not rely on it for medical, legal, financial, or emergency
        communications.
      </p>
      <button
        type="button"
        onClick={handleDismiss}
        className="shrink-0 font-medium underline decoration-dotted underline-offset-2"
        aria-label="Dismiss translation quality notice"
      >
        Dismiss
      </button>
    </div>
  );
}
