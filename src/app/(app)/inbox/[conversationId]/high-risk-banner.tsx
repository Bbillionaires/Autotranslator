/**
 * Persistent high-risk-conversation warning, per docs/implementation-plan.md §6.9: "flagging
 * a conversation as high-risk surfaces a stronger inline warning above the composer every
 * time a message is sent in that thread." Rendered above the message thread AND repeated
 * just above the composer (see composer.tsx) so it's visible right before the send action,
 * not just once at the top of the page.
 */
export function HighRiskBanner({ compact = false }: { compact?: boolean }) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 text-danger ${
        compact ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm"
      }`}
    >
      <span aria-hidden="true">⚠</span>
      <p>
        <strong>High-risk conversation.</strong> Machine translation can make mistakes — do not rely on this for
        medical, legal, financial, or emergency communications.
      </p>
    </div>
  );
}
