"use client";

/**
 * Minimal Telegram settings section, per the Phase 6 task brief's deliverable #12: an
 * Administrator can see connection status/health and the webhook-config helper output.
 * Deliberately small — full Settings UI polish (glossary management, org defaults, etc.) is
 * Phase 7's job; this only covers what Phase 6 needs to be a real, usable feature.
 */
import { useEffect, useState, useTransition } from "react";
import {
  getTelegramHealthStatus,
  getTelegramWebhookConfig,
  registerTelegramWebhook,
  type TelegramHealthStatus,
  type TelegramWebhookConfig,
} from "@/server/actions/telegram";

type Loadable<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

export function TelegramSettingsSection() {
  const [config, setConfig] = useState<Loadable<TelegramWebhookConfig>>({ status: "loading" });
  const [health, setHealth] = useState<Loadable<TelegramHealthStatus>>({ status: "loading" });
  const [registerMessage, setRegisterMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      const [configResult, healthResult] = await Promise.all([getTelegramWebhookConfig(), getTelegramHealthStatus()]);
      setConfig(configResult.ok ? { status: "ready", data: configResult.data } : { status: "error", message: configResult.message });
      setHealth(healthResult.ok ? { status: "ready", data: healthResult.data } : { status: "error", message: healthResult.message });
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleRegister() {
    setRegisterMessage(null);
    startTransition(async () => {
      const result = await registerTelegramWebhook();
      setRegisterMessage(result.ok ? result.data.description : result.message);
      refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Telegram</h2>
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
            {!health.data.enabled ? "Disabled" : health.data.healthy ? "Connected" : "Unhealthy"}
          </span>
        )}
      </div>

      {health.status === "loading" && <p className="text-sm text-muted">Checking connection…</p>}
      {health.status === "error" && <p className="text-sm text-danger">{health.message}</p>}
      {health.status === "ready" && health.data.detail && <p className="text-sm text-muted">{health.data.detail}</p>}

      {config.status === "ready" && (
        <div className="flex flex-col gap-2 text-sm text-foreground">
          <div>
            <span className="font-medium">Webhook URL: </span>
            <code className="rounded bg-background px-1 py-0.5 text-xs">{config.data.webhookUrl}</code>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            {config.data.instructions.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ol>
        </div>
      )}
      {config.status === "error" && <p className="text-sm text-danger">{config.message}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleRegister}
          disabled={isPending || config.status !== "ready" || !config.data.telegramEnabled}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          Register webhook now
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={isPending}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground disabled:opacity-50"
        >
          Refresh status
        </button>
      </div>
      {registerMessage && <p className="text-sm text-muted">{registerMessage}</p>}
    </section>
  );
}
