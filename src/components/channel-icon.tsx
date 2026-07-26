/**
 * Channel icon, per the Phase 7 task brief ("channel icon: channel icon (Telegram for now;
 * generic icons for other channel types is fine)"). Text/emoji glyphs rather than external
 * icon-font assets — no new dependency, and every glyph is paired with an `aria-label` plus
 * a visible text label at call sites (never color/icon alone).
 */
import type { ChannelType } from "@prisma/client";

const CHANNEL_CONFIG: Record<ChannelType, { glyph: string; label: string }> = {
  TELEGRAM: { glyph: "✈", label: "Telegram" },
  ANDROID_SMS: { glyph: "📱", label: "SMS" },
  WHATSAPP: { glyph: "💬", label: "WhatsApp" },
  MESSENGER: { glyph: "💬", label: "Messenger" },
  INSTAGRAM: { glyph: "📷", label: "Instagram" },
  EMAIL: { glyph: "✉", label: "Email" },
};

export function ChannelIcon({ channel, className }: { channel: ChannelType; className?: string }) {
  const config = CHANNEL_CONFIG[channel];
  return (
    <span
      role="img"
      aria-label={config.label}
      title={config.label}
      className={className ?? "inline-flex h-6 w-6 items-center justify-center rounded-full bg-background text-sm"}
    >
      {config.glyph}
    </span>
  );
}

export function channelLabel(channel: ChannelType): string {
  return CHANNEL_CONFIG[channel].label;
}
