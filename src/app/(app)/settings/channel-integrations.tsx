/**
 * Channel integrations list — Phase 7 originally added Telegram (real) plus Android/WhatsApp
 * as "not yet configured" placeholders. Phase 9 replaced the WhatsApp placeholder with its
 * own real (but honest — see `whatsapp-section.tsx`'s doc comment) status section, matching
 * Telegram's precedent. M5 (docs/review-report.md) replaces the Android placeholder the same
 * way: `android-section.tsx` is a real device list/register/revoke section, not a stub.
 */
import { TelegramSettingsSection } from "./telegram-section";
import { AndroidSettingsSection } from "./android-section";
import { WhatsAppSettingsSection } from "./whatsapp-section";

export function ChannelIntegrationsList() {
  return (
    <div className="flex flex-col gap-4">
      <TelegramSettingsSection />
      <AndroidSettingsSection />
      <WhatsAppSettingsSection />
    </div>
  );
}
