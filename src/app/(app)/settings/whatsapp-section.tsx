"use client";

/**
 * WhatsApp settings section, rewritten for per-organization credentials. Each org's own
 * Administrator pastes their own WhatsApp Cloud API credentials (access token, phone number
 * id, business account id, app secret, a self-chosen verify token) — validated against the
 * Graph API before saving. Registering the webhook URL with Meta remains a manual,
 * dashboard-only step (see docs/channel-adapters.md) — this form only creates the
 * `ChannelAccount` and shows the URL to paste into Meta's dashboard, unlike Telegram's fully
 * automatic "Connect bot" flow.
 */
import { useEffect, useState, useTransition } from "react";
import {
  connectWhatsAppAccount,
  getWhatsAppHealthStatus,
  getWhatsAppWebhookConfig,
  type WhatsAppHealthStatus,
  type WhatsAppWebhookConfig,
} from "@/server/actions/whatsapp";

type Loadable<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

const EMPTY_FORM = { accessToken: "", phoneNumberId: "", businessAccountId: "", appSecret: "", verifyToken: "" };

export function WhatsAppSettingsSection() {
  const [health, setHealth] = useState<Loadable<WhatsAppHealthStatus>>({ status: "loading" });
  const [config, setConfig] = useState<Loadable<WhatsAppWebhookConfig>>({ status: "loading" });
  const [form, setForm] = useState(EMPTY_FORM);
  const [connectMessage, setConnectMessage] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      const [healthResult, configResult] = await Promise.all([getWhatsAppHealthStatus(), getWhatsAppWebhookConfig()]);
      setHealth(healthResult.ok ? { status: "ready", data: healthResult.data } : { status: "error", message: healthResult.message });
      setConfig(configResult.ok ? { status: "ready", data: configResult.data } : { status: "error", message: configResult.message });
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
      const result = await connectWhatsAppAccount(form);
      if (!result.ok) {
        setConnectError(result.message);
        return;
      }
      setConnectMessage(
        `Connected (${result.data.displayName}). Now register this webhook URL in your Meta App dashboard: ${result.data.webhookUrl}`,
      );
      setForm(EMPTY_FORM);
      refresh();
    });
  }

  const whatsAppEnabled = health.status === "ready" && health.data.enabled;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">WhatsApp Business</h2>
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
            {!health.data.enabled ? "Not enabled" : !health.data.connected ? "Not connected" : health.data.healthy ? "Connected" : "Unhealthy"}
          </span>
        )}
      </div>

      {health.status === "loading" && <p className="text-sm text-muted">Checking connection…</p>}
      {health.status === "error" && <p className="text-sm text-danger">{health.message}</p>}

      {health.status === "ready" && !health.data.enabled && (
        <p className="text-sm text-muted">
          Not enabled for this deployment — an operator must set{" "}
          <code className="rounded bg-background px-1 py-0.5 text-xs">WHATSAPP_ENABLED=true</code> (and restart the app) before any
          organization can connect an account. See the &ldquo;WhatsApp Business Cloud API&rdquo; section of{" "}
          <code className="rounded bg-background px-1 py-0.5 text-xs">docs/channel-adapters.md</code> for the full Meta-side setup checklist.
        </p>
      )}

      {health.status === "ready" && health.data.enabled && health.data.detail && (
        <p className="text-sm text-muted">{health.data.detail}</p>
      )}

      {config.status === "ready" && config.data.connected && config.data.webhookUrl && (
        <div className="flex flex-col gap-1 text-sm text-foreground">
          <span className="font-medium">Your organization&rsquo;s webhook URL (register this in your Meta App dashboard): </span>
          <code className="break-all rounded bg-background px-1 py-0.5 text-xs">{config.data.webhookUrl}</code>
        </div>
      )}

      {whatsAppEnabled && (
        <form onSubmit={handleConnect} className="grid grid-cols-1 gap-2 border-t border-border pt-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Access token
            <input
              type="password"
              value={form.accessToken}
              onChange={(e) => setForm((f) => ({ ...f, accessToken: e.target.value }))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Phone number id
            <input
              value={form.phoneNumberId}
              onChange={(e) => setForm((f) => ({ ...f, phoneNumberId: e.target.value }))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Business account id
            <input
              value={form.businessAccountId}
              onChange={(e) => setForm((f) => ({ ...f, businessAccountId: e.target.value }))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            App secret
            <input
              type="password"
              value={form.appSecret}
              onChange={(e) => setForm((f) => ({ ...f, appSecret: e.target.value }))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
            Verify token (choose your own random string; must match what you enter in Meta&rsquo;s dashboard)
            <input
              value={form.verifyToken}
              onChange={(e) => setForm((f) => ({ ...f, verifyToken: e.target.value }))}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </label>
          <div className="flex items-center gap-2 sm:col-span-2">
            <button
              type="submit"
              disabled={isPending || Object.values(form).some((v) => !v)}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              {config.status === "ready" && config.data.connected ? "Reconnect account" : "Connect account"}
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
        </form>
      )}
      {connectError && <p className="text-sm text-danger">{connectError}</p>}
      {connectMessage && <p className="text-sm text-success">{connectMessage}</p>}
    </section>
  );
}
