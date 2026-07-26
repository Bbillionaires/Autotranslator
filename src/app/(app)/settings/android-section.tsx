"use client";

/**
 * Android SMS gateway Settings section — M5 fix (docs/review-report.md), paired with H6
 * (device revocation). Replaces the generic "Not yet configured" placeholder
 * (`channel-integrations.tsx`) with a real device list (health/heartbeat status), a
 * register form that shows the one-time device token, and a revoke button per device.
 * Wired to `src/server/actions/android.ts`, matching the Telegram section's structure
 * (`telegram-section.tsx`) as closely as possible for UI consistency.
 */
import { useEffect, useState, useTransition } from "react";
import {
  listAndroidDevices,
  registerAndroidDevice,
  revokeAndroidDevice,
  type AndroidDeviceView,
} from "@/server/actions/android";

type Loadable<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

export function AndroidSettingsSection() {
  const [devices, setDevices] = useState<Loadable<AndroidDeviceView[]>>({ status: "loading" });
  const [deviceName, setDeviceName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<{ deviceId: string; deviceToken: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      const result = await listAndroidDevices();
      setDevices(result.ok ? { status: "ready", data: result.data } : { status: "error", message: result.message });
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleRegister(event: React.FormEvent) {
    event.preventDefault();
    setRegisterError(null);
    setIssuedToken(null);
    startTransition(async () => {
      const result = await registerAndroidDevice({ deviceName, phoneNumber });
      if (!result.ok) {
        setRegisterError(result.message);
        return;
      }
      setIssuedToken(result.data);
      setDeviceName("");
      setPhoneNumber("");
      refresh();
    });
  }

  function handleRevoke(deviceId: string) {
    startTransition(async () => {
      const result = await revokeAndroidDevice({ deviceId });
      if (!result.ok) {
        setRegisterError(result.message);
        return;
      }
      refresh();
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Android SMS gateway</h2>
      </div>

      {devices.status === "loading" && <p className="text-sm text-muted">Loading devices…</p>}
      {devices.status === "error" && <p className="text-sm text-danger">{devices.message}</p>}

      {devices.status === "ready" && (
        <div className="flex flex-col gap-2">
          {devices.data.length === 0 && <p className="text-sm text-muted">No devices registered yet.</p>}
          {devices.data.map((device) => (
            <div
              key={device.id}
              className="flex flex-col gap-1 rounded-md border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <div className="text-sm font-medium text-foreground">
                  {device.displayName} <span className="text-xs text-muted">({device.phoneNumber ?? "no phone number"})</span>
                </div>
                <div className="text-xs text-muted">{device.healthDetail}</div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    device.revokedAt
                      ? "bg-muted/10 text-muted"
                      : device.healthy
                        ? "bg-success/10 text-success"
                        : "bg-danger/10 text-danger"
                  }`}
                >
                  {device.revokedAt ? "Revoked" : device.healthy ? "Healthy" : "Unhealthy"}
                </span>
                {!device.revokedAt && (
                  <button
                    type="button"
                    onClick={() => handleRevoke(device.id)}
                    disabled={isPending}
                    className="rounded-md border border-danger/40 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleRegister} className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor="android-device-name" className="text-xs font-medium text-muted">
            Device name
          </label>
          <input
            id="android-device-name"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="Front desk Pixel"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor="android-phone-number" className="text-xs font-medium text-muted">
            Phone number
          </label>
          <input
            id="android-phone-number"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+15551234567"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
        </div>
        <button
          type="submit"
          disabled={isPending || !deviceName || !phoneNumber}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          Register device
        </button>
      </form>

      {registerError && <p className="text-sm text-danger">{registerError}</p>}

      {issuedToken && (
        <div className="flex flex-col gap-1 rounded-md border border-accent/40 bg-accent/10 p-3 text-sm text-foreground">
          <p className="font-medium">Device token (shown once — copy it into the device now):</p>
          <code className="break-all rounded bg-background px-2 py-1 text-xs">{issuedToken.deviceToken}</code>
          <p className="text-xs text-muted">
            This will not be shown again. See <code className="rounded bg-background px-1 py-0.5">android-gateway/README.md</code> for how the
            companion app should store it.
          </p>
        </div>
      )}
    </section>
  );
}
