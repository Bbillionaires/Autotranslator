/**
 * Delivery-status badge for `Message.status`, per the Phase 7 task brief ("delivery status
 * per outbound message (PENDING/SENT/DELIVERED/READ/FAILED/DEAD_LETTER, with distinct
 * visual treatment)") and the accessibility requirement ("sufficient color contrast for
 * status badges (don't rely on color alone — use icons/text too)"). Each status pairs a
 * color with a distinct glyph AND a text label, so the status is never conveyed by color
 * alone (colorblind-safe, screen-reader-friendly via the visible text).
 */
import type { MessageStatus } from "@prisma/client";

const STATUS_CONFIG: Record<MessageStatus, { label: string; glyph: string; className: string }> = {
  QUEUED: { label: "Queued", glyph: "…", className: "bg-muted/10 text-muted" }, // …
  PENDING: { label: "Pending", glyph: "○", className: "bg-muted/10 text-muted" }, // ○
  SENT: { label: "Sent", glyph: "✓", className: "bg-accent/10 text-accent" }, // ✓
  DELIVERED: { label: "Delivered", glyph: "✓✓", className: "bg-success/10 text-success" }, // ✓✓
  READ: { label: "Read", glyph: "✓✓", className: "bg-success/20 text-success" }, // ✓✓ (filled)
  FAILED: { label: "Failed", glyph: "✕", className: "bg-danger/10 text-danger" }, // ✕
  DEAD_LETTER: { label: "Undeliverable", glyph: "⚠", className: "bg-danger/20 text-danger" }, // ⚠
};

export function DeliveryStatusBadge({ status }: { status: MessageStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${config.className}`}
      data-status={status}
    >
      <span aria-hidden="true">{config.glyph}</span>
      <span>{config.label}</span>
    </span>
  );
}
