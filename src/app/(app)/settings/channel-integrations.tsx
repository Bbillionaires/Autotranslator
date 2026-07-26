/**
 * Channel integrations list — Phase 7 originally added Telegram (real) plus Android/WhatsApp
 * as "not yet configured" placeholders. Phase 9 replaces the WhatsApp placeholder with its
 * own real (but honest — see `whatsapp-section.tsx`'s doc comment) status section, matching
 * Telegram's precedent. Android SMS (Phase 8, server-side complete) still shows the generic
 * placeholder below — Phase 8 never wired a dedicated Settings UI section for it (see
 * docs/channel-adapters.md's Android "Known limitations": no revoke button either), a
 * pre-existing gap out of this phase's scope, left as-is rather than silently expanded here.
 */
import { ChannelIcon } from "@/components/channel-icon";
import { TelegramSettingsSection } from "./telegram-section";
import { WhatsAppSettingsSection } from "./whatsapp-section";

function PlaceholderChannelCard({ channel, label, phase }: { channel: "ANDROID_SMS"; label: string; phase: string }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChannelIcon channel={channel} />
          <h2 className="text-lg font-semibold text-foreground">{label}</h2>
        </div>
        <span className="rounded-full bg-muted/10 px-2 py-0.5 text-xs font-medium text-muted">Not yet configured</span>
      </div>
      <p className="text-sm text-muted">{phase}</p>
    </section>
  );
}

export function ChannelIntegrationsList() {
  return (
    <div className="flex flex-col gap-4">
      <TelegramSettingsSection />
      <PlaceholderChannelCard
        channel="ANDROID_SMS"
        label="Android SMS gateway"
        phase="Device registration, heartbeat, and message polling shipped in Phase 8 (server-side). No Settings UI section is wired up here yet — a documented follow-up, see docs/channel-adapters.md."
      />
      <WhatsAppSettingsSection />
    </div>
  );
}
