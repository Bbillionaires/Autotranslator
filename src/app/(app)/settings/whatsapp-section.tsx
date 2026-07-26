"use client";

/**
 * Minimal WhatsApp settings section, per the Phase 9 task brief's deliverable #7: replaces
 * the Phase 7 "Not yet configured" placeholder with a real, honest status. Deliberately
 * small (matching Telegram's section's own "deliberately small" precedent) — there is no
 * "connect" action here (unlike Telegram's "Register webhook now"), since registering the
 * webhook URL + verify token with Meta is an external, human, dashboard-only step (see
 * docs/channel-adapters.md's WhatsApp section) that this app cannot perform on the
 * operator's behalf.
 */
import { useEffect, useState, useTransition } from "react";
import { getWhatsAppHealthStatus, type WhatsAppHealthStatus } from "@/server/actions/whatsapp";

type Loadable<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

export function WhatsAppSettingsSection() {
  const [health, setHealth] = useState<Loadable<WhatsAppHealthStatus>>({ status: "loading" });
  const [isPending, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      const result = await getWhatsAppHealthStatus();
      setHealth(result.ok ? { status: "ready", data: result.data } : { status: "error", message: result.message });
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">WhatsApp Business</h2>
        {health.status === "ready" && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              health.data.enabled && health.data.healthy
                ? "bg-success/10 text-success"
                : health.data.enabled
                  ? "bg-danger/10 text-danger"
                  : "bg-muted/10 text-muted"
            }`}
          >
            {!health.data.enabled ? "Not enabled" : health.data.healthy ? "Connected" : "Unhealthy"}
          </span>
        )}
      </div>

      {health.status === "loading" && <p className="text-sm text-muted">Checking connection…</p>}
      {health.status === "error" && <p className="text-sm text-danger">{health.message}</p>}

      {health.status === "ready" && !health.data.enabled && (
        <p className="text-sm text-muted">
          Not enabled — requires a Meta Business Manager account, an App with the WhatsApp
          product, and (for production traffic beyond a handful of test numbers) completed
          Business Verification/App Review. See the &ldquo;WhatsApp Business Cloud API&rdquo;
          section of <code className="rounded bg-background px-1 py-0.5 text-xs">docs/channel-adapters.md</code>{" "}
          for the full setup checklist (all external, Meta-side steps — nothing here can do
          this for you).
        </p>
      )}

      {health.status === "ready" && health.data.enabled && health.data.detail && (
        <p className="text-sm text-muted">{health.data.detail}</p>
      )}

      <div>
        <button
          type="button"
          onClick={refresh}
          disabled={isPending}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground disabled:opacity-50"
        >
          Refresh status
        </button>
      </div>
    </section>
  );
}
