"use client";

/**
 * Compose field — Phase 7. Two things make this more than a plain textarea+button:
 *
 * 1. A target-language indicator computed server-side (via §3.4's `resolveTargetLanguage`,
 *    passed in as `targetLanguage`) so "this will be translated to X" can never drift from
 *    what `outboundService.sendMessage` actually resolves at send time.
 * 2. A "review before send" toggle: when on, `sendConversationMessage` is called with
 *    `reviewBeforeSend: true`, which (per §3.6 step 4 / `outboundService.sendMessage`) stops
 *    after storing the translated draft as `PENDING` and returns it instead of sending. This
 *    component then shows that draft (editable — an edit calls `recordTranslationEdit`,
 *    which audit-logs the change per §6.8, never a silent overwrite) and only calls
 *    `confirmAndSendConversationMessage` once the user explicitly confirms.
 *
 * Also supports an "Internal note" mode (`addConversationInternalNote`) — entirely separate
 * from the reply path, never translated or sent through a channel adapter.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { languageLabel } from "@/lib/languages";
import { confirmAndSendConversationMessage, recordTranslationEdit, sendConversationMessage } from "@/server/actions/messages";
import { addConversationInternalNote } from "@/server/actions/conversations";
import { HighRiskBanner } from "./high-risk-banner";

type Mode = "reply" | "note";

interface Draft {
  id: string;
  translatedText: string | null;
  originalText: string;
}

export function Composer({
  conversationId,
  targetLanguage,
  reviewBeforeSendDefault,
  canSend,
  highRisk,
}: {
  conversationId: string;
  targetLanguage: string;
  reviewBeforeSendDefault: boolean;
  canSend: boolean;
  highRisk: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("reply");
  const [text, setText] = useState("");
  const [reviewBeforeSend, setReviewBeforeSend] = useState(reviewBeforeSendDefault);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftText, setDraftText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!canSend) {
    return (
      <p className="rounded-lg border border-dashed border-border p-3 text-center text-sm text-muted">
        You have read-only access to this conversation and cannot send messages.
      </p>
    );
  }

  function resetComposer() {
    setText("");
    setDraft(null);
    setDraftText("");
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setError(null);

    startTransition(async () => {
      if (mode === "note") {
        const result = await addConversationInternalNote({ conversationId, text });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        resetComposer();
        router.refresh();
        return;
      }

      const result = await sendConversationMessage({ conversationId, text, reviewBeforeSend });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.data.outcome === "DRAFT") {
        setDraft({
          id: result.data.message.id,
          translatedText: result.data.message.translatedText,
          originalText: result.data.message.originalText,
        });
        setDraftText(result.data.message.translatedText ?? result.data.message.originalText);
        return;
      }
      resetComposer();
      router.refresh();
    });
  }

  function handleConfirmSend() {
    if (!draft) return;
    setError(null);
    startTransition(async () => {
      if (draftText !== (draft.translatedText ?? draft.originalText)) {
        const editResult = await recordTranslationEdit({ messageId: draft.id, translatedText: draftText });
        if (!editResult.ok) {
          setError(editResult.message);
          return;
        }
      }
      const sendResult = await confirmAndSendConversationMessage({ messageId: draft.id });
      if (!sendResult.ok) {
        setError(sendResult.message);
        return;
      }
      resetComposer();
      router.refresh();
    });
  }

  if (draft) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
        <p className="text-xs font-medium text-muted">
          Review the translation (target language: {languageLabel(targetLanguage)}) before sending:
        </p>
        <textarea
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          rows={3}
          aria-label="Translated draft (editable)"
          className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground"
        />
        <p className="text-xs text-muted">Original: {draft.originalText}</p>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleConfirmSend}
            disabled={isPending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            {isPending ? "Sending…" : "Confirm & send"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      {highRisk && <HighRiskBanner compact />}

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <div className="flex items-center gap-1" role="group" aria-label="Compose mode">
          <button
            type="button"
            onClick={() => setMode("reply")}
            aria-pressed={mode === "reply"}
            className={`rounded-md px-2 py-1 font-medium ${mode === "reply" ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-background"}`}
          >
            Reply to contact
          </button>
          <button
            type="button"
            onClick={() => setMode("note")}
            aria-pressed={mode === "note"}
            className={`rounded-md px-2 py-1 font-medium ${mode === "note" ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-background"}`}
          >
            Internal note
          </button>
        </div>

        {mode === "reply" && (
          <span>
            Will be translated to <strong className="text-foreground">{languageLabel(targetLanguage)}</strong>
          </span>
        )}

        {mode === "reply" && (
          <label className="ml-auto flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={reviewBeforeSend}
              onChange={(e) => setReviewBeforeSend(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            Review translation before sending
          </label>
        )}
      </div>

      <label htmlFor="composer-text" className="sr-only">
        {mode === "note" ? "Internal note text" : "Message text"}
      </label>
      <textarea
        id="composer-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder={mode === "note" ? "Add a note only your team can see…" : "Type your reply…"}
        className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground"
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isPending || !text.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {isPending ? "Sending…" : mode === "note" ? "Save note" : "Send"}
        </button>
      </div>
    </form>
  );
}
