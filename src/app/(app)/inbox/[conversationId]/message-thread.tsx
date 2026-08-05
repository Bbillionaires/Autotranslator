"use client";

/**
 * Message thread — Phase 7. Each message shows `translatedText` by default with a "Show
 * original" toggle revealing `originalText` (both are already in the payload from the
 * server — no re-fetch, per the Phase 7 task brief). Internal notes
 * (`isInternalNote: true`) are rendered with a visually distinct treatment (dashed amber
 * border/background + an explicit "Internal note" label) so they can never be confused with
 * something the contact actually sees.
 */
import { useState, useTransition } from "react";
import type { Message } from "@prisma/client";
import { DeliveryStatusBadge } from "@/components/delivery-status-badge";
import { retryConversationMessage, retryInboundMessageTranslation } from "@/server/actions/messages";

function TranslationStatusBadge({ message }: { message: Message }) {
  if (message.isInternalNote) {
    return null;
  }
  if (!message.translatedText || message.translatedText === message.originalText) {
    return <span className="text-xs text-muted">Original only (no translation needed)</span>;
  }
  return (
    <span className="text-xs text-muted">
      Translated{message.translationProvider ? ` · ${message.translationProvider}` : ""}
      {message.translationEdited ? " · edited" : ""}
    </span>
  );
}

function MessageBubble({ message, canRetry }: { message: Message; canRetry: boolean }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [retryError, setRetryError] = useState<string | null>(null);

  if (message.isInternalNote) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-dashed border-amber-500/60 bg-amber-500/10 p-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
          <span aria-hidden="true">🔒</span>
          <span>Internal note — not visible to contact</span>
          <time className="ml-auto font-normal normal-case text-muted" dateTime={message.createdAt.toISOString()}>
            {new Date(message.createdAt).toLocaleString()}
          </time>
        </div>
        <p className="whitespace-pre-wrap text-sm text-foreground">{message.originalText}</p>
      </div>
    );
  }

  const isInbound = message.direction === "INBOUND";
  const displayText = showOriginal ? message.originalText : (message.translatedText ?? message.originalText);
  const canShowToggle = Boolean(message.translatedText) && message.translatedText !== message.originalText;
  // T1 fix (docs/test-report.md): a FAILED/DEAD_LETTER OUTBOUND message retries via
  // `retryConversationMessage` (adapter resend, possibly re-translating first); a FAILED
  // INBOUND message (translation failed on receipt — DEAD_LETTER never applies to inbound,
  // there's no automatic retry/backoff for it) retries via `retryInboundMessageTranslation`
  // instead — see `handleRetry` below. Routing an inbound message through the outbound retry
  // action would incorrectly try to "send" it back out through the channel adapter.
  const canRetryThis = canRetry && (message.status === "FAILED" || message.status === "DEAD_LETTER");

  function handleRetry() {
    setRetryError(null);
    startTransition(async () => {
      const result = isInbound
        ? await retryInboundMessageTranslation({ messageId: message.id })
        : await retryConversationMessage({ messageId: message.id });
      if (!result.ok) {
        setRetryError(result.message);
      }
    });
  }

  return (
    <div className={`flex flex-col gap-1 ${isInbound ? "items-start" : "items-end"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isInbound ? "bg-surface text-foreground" : "bg-accent/10 text-foreground"
        }`}
      >
        <p className="whitespace-pre-wrap">{displayText}</p>
        {canShowToggle && (
          <button
            type="button"
            onClick={() => setShowOriginal((v) => !v)}
            className="mt-1 text-xs font-medium text-accent hover:underline"
          >
            {showOriginal ? "Show translation" : "Show original"}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted">
        <span>{isInbound ? "Contact" : "You"}</span>
        <time dateTime={message.createdAt.toISOString()}>{new Date(message.createdAt).toLocaleString()}</time>
        <TranslationStatusBadge message={message} />
        {!isInbound && <DeliveryStatusBadge status={message.status} />}
        {canRetryThis && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={isPending}
            className="rounded-md border border-danger/40 px-2 py-0.5 font-medium text-danger disabled:opacity-50"
          >
            {isPending ? "Retrying…" : "Retry"}
          </button>
        )}
      </div>
      {retryError && <p className="px-1 text-xs text-danger">{retryError}</p>}
    </div>
  );
}

export function MessageThread({ messages, canRetry }: { messages: Message[]; canRetry: boolean }) {
  if (messages.length === 0) {
    return (
      <div className="flex-1 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
        No messages yet.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-background p-3">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} canRetry={canRetry} />
      ))}
    </div>
  );
}
