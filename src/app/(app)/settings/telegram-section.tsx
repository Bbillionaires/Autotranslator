"use client";

/**
 * Telegram settings section, rewritten for per-organization bot credentials. Each org's own
 * Administrator connects their OWN bot by pasting a token from @BotFather — this is no
 * longer a "show me the globally-configured bot's status" panel, it's a real connect form.
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
  const [botToken, setBotToken] = useState("");
  const [connectMessage, setConnectMessage] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
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

  function handleConnect(event: React.FormEvent) {
    event.preventDefault();
    setConnectMessage(null);
    setConnectError(null);
    startTransition(async () => {
      const result = await registerTelegramWebhook({ botToken });
      if (!result.ok) {
        setConnectError(result.message);
        return;
      }
      setConnectMessage(`Connected as ${result.data.displayName}. ${result.data.description}`);
      setBotToken("");
      refresh();
    });
  }

  const telegramEnabled = config.status === "ready" && config.data.telegramEnabled;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Telegram</h2>
        {health.status === "ready" && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              health.data.enabled && health.data.connected && health.data.healthy
                ? "bg-success/10 text-success"
                : health.data.enabled && health.data.connected
                  ? "bg-danger/10 text-danger"
                  : "bg-muted/10 text-muted"
            }`}
          >
            {!health.data.enabled ? "Disabled" : !health.data.connected ? "Not connected" : health.data.healthy ? "Connected" : "Unhealthy"}
          </span>
        )}
      </div>

      {health.status === "loading" && <p className="text-sm text-muted">Checking connection…</p>}
      {health.status === "error" && <p className="text-sm text-danger">{health.message}</p>}
      {health.status === "ready" && health.data.detail && <p className="text-sm text-muted">{health.data.detail}</p>}

      {config.status === "ready" && !config.data.telegramEnabled && (
        <p className="text-sm text-muted">
          Telegram is disabled for this deployment. An operator must set <code className="rounded bg-background px-1 py-0.5 text-xs">TELEGRAM_ENABLED=true</code>{" "}
          (and restart the app) before any organization can connect a bot.
        </p>
      )}

      {config.status === "ready" && config.data.connected && config.data.webhookUrl && (
        <div className="flex flex-col gap-1 text-sm text-foreground">
          <span className="font-medium">Your organization&rsquo;s webhook URL: </span>
          <code className="break-all rounded bg-background px-1 py-0.5 text-xs">{config.data.webhookUrl}</code>
          <span className="text-xs text-muted">Registered automatically with Telegram when you connected your bot below.</span>
        </div>
      )}

      {config.status === "ready" && config.data.instructions.length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          {config.data.instructions.map((instruction) => (
            <li key={instruction}>{instruction}</li>
          ))}
        </ol>
      )}
      {config.status === "error" && <p className="text-sm text-danger">{config.message}</p>}

      <form onSubmit={handleConnect} className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor="telegram-bot-token" className="text-xs font-medium text-muted">
            Bot token (from @BotFather)
          </label>
          <input
            id="telegram-bot-token"
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="123456789:AAExampleTokenNotReal"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        <button
          type="submit"
          disabled={isPending || !botToken || !telegramEnabled}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {config.status === "ready" && config.data.connected ? "Reconnect bot" : "Connect bot"}
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={isPending}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground disabled:opacity-50"
        >
          Refresh status
        </button>
      </form>
      {connectError && <p className="text-sm text-danger">{connectError}</p>}
      {connectMessage && <p className="text-sm text-success">{connectMessage}</p>}
    </section>
  );
}
