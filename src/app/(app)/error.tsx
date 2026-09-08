"use client";

/**
 * Error boundary for the entire `(app)` route segment (Inbox, Contacts, Teams, Settings).
 *
 * Before this file existed, ANY unhandled client-side rendering error anywhere in this
 * subtree (Nav, TranslationDisclosureBanner, a page component, a conversation row, ...) had
 * no boundary to catch it — Next.js's default behavior without an `error.tsx` is to let the
 * failure propagate, which can present to the user as the whole page failing to load with no
 * useful message and, critically, leaves NO record of what happened anywhere a server log
 * could ever show — a real crash was reported in production and could not be diagnosed from
 * Railway's logs alone because of exactly this gap. This file closes that gap two ways: (1)
 * shows a recoverable "Something went wrong" screen with a retry button instead of a dead
 * end, and (2) reports the error to `/api/client-error-report` so it lands in the same
 * structured server logs as every other error, where it's actually visible.
 */
import { useEffect } from "react";
import Link from "next/link";

export default function AppSegmentError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    fetch("/api/client-error-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        path: typeof window !== "undefined" ? window.location.pathname : undefined,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        boundary: "app",
      }),
    }).catch(() => {
      // Best-effort only — if the report itself can't be sent, there's nothing more useful
      // to do than let the user still see the recoverable error screen below.
    });
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted">
        This page ran into an unexpected error. It&apos;s been reported. You can try again, or go back to the
        inbox.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground"
        >
          Try again
        </button>
        <Link href="/inbox" className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground">
          Back to inbox
        </Link>
      </div>
      {error.digest ? <p className="text-xs text-muted">Reference: {error.digest}</p> : null}
    </div>
  );
}
