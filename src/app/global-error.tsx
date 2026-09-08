"use client";

/**
 * Root-level error boundary — catches anything `(app)/error.tsx` can't, specifically errors
 * thrown by the root layout itself (`src/app/layout.tsx`) or by `(auth)` segment pages
 * (sign-in), since a segment-level `error.tsx` cannot catch an error in its own parent
 * layout. `global-error.tsx` must render its own `<html>`/`<body>` (Next.js convention) since
 * it replaces the root layout entirely when active. See `(app)/error.tsx` for why this
 * exists at all — reporting to `/api/client-error-report` so a client-only crash actually
 * shows up somewhere a server log can be read, instead of vanishing with no diagnostic trail.
 */
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
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
        boundary: "global",
      }),
    }).catch(() => {});
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div style={{ display: "flex", minHeight: "100vh", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem", padding: "2rem", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
          <h1 style={{ fontSize: "1.125rem", fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ maxWidth: "24rem", fontSize: "0.875rem", color: "#666" }}>
            AutoTranslator ran into an unexpected error. It&apos;s been reported.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{ borderRadius: "0.375rem", background: "#111", color: "#fff", padding: "0.5rem 1rem", fontSize: "0.875rem", fontWeight: 500, border: "none", cursor: "pointer" }}
          >
            Try again
          </button>
          {error.digest ? <p style={{ fontSize: "0.75rem", color: "#999" }}>Reference: {error.digest}</p> : null}
        </div>
      </body>
    </html>
  );
}
