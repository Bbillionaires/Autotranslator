/**
 * Channel integrations list — Phase 7 ("channel integrations list (Telegram section already
 * exists from Phase 6 — keep it, add Android/WhatsApp as 'not yet configured' placeholders
 * that later phases will fill in)"). No client state needed for the placeholders themselves
 * — they're static until Phase 8/9 land.
 */
import { ChannelIcon } from "@/components/channel-icon";
import { TelegramSettingsSection } from "./telegram-section";

function PlaceholderChannelCard({ channel, label, phase }: { channel: "ANDROID_SMS" | "WHATSAPP"; label: string; phase: string }) {
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
        phase="Device registration, heartbeat, and message polling ship in Phase 8."
      />
      <PlaceholderChannelCard
        channel="WHATSAPP"
        label="WhatsApp Business"
        phase="Graph API integration and webhook verification ship in Phase 9 (behind the WHATSAPP_ENABLED flag)."
      />
    </div>
  );
}
