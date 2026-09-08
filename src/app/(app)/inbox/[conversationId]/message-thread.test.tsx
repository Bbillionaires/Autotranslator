// @vitest-environment jsdom
/**
 * Component tests for `MessageThread`, per the Phase 7 task brief: the original/translated
 * toggle, internal notes rendered distinctly from contact-visible messages, and the retry
 * action being present/absent based on the `canRetry` (role-gated) prop.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Message } from "@prisma/client";

vi.mock("@/server/actions/messages", () => ({
  retryConversationMessage: vi.fn(async () => ({ ok: true, data: {} })),
  retryInboundMessageTranslation: vi.fn(async () => ({ ok: true, data: {} })),
}));

const { MessageThread } = await import("./message-thread");

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organizationId: "org1",
    conversationId: "c1",
    senderType: "CONTACT",
    direction: "INBOUND",
    originalText: "Hola",
    translatedText: "Hello",
    sourceLanguage: "es",
    targetLanguage: "en",
    translationProvider: "noop",
    translationConfidence: 0.9,
    translationEdited: false,
    channelType: "TELEGRAM",
    externalMessageId: null,
    externalReplyToId: null,
    status: "DELIVERED",
    failureReason: null,
    idempotencyKey: "key1",
    isInternalNote: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Message;
}

describe("MessageThread", () => {
  it("shows translated text by default and reveals the original on toggle, with no re-fetch", () => {
    render(<MessageThread messages={[makeMessage()]} canRetry={false} />);

    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.queryByText("Hola")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show original/i }));
    expect(screen.getByText("Hola")).toBeInTheDocument();
    expect(screen.queryByText("Hello")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show translation/i }));
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("renders internal notes with a distinct 'Internal note' label, separate from contact-visible messages", () => {
    render(
      <MessageThread
        messages={[
          makeMessage({
            id: "m2",
            isInternalNote: true,
            direction: "OUTBOUND",
            originalText: "Called the customer, no answer.",
            translatedText: null,
          }),
        ]}
        canRetry={false}
      />,
    );

    expect(screen.getByText(/internal note/i)).toBeInTheDocument();
    expect(screen.getByText("Called the customer, no answer.")).toBeInTheDocument();
  });

  it("shows a retry button for a FAILED outbound message only when canRetry is true", () => {
    const failed = makeMessage({ id: "m3", direction: "OUTBOUND", status: "FAILED", translatedText: "Bonjour" });

    const { rerender } = render(<MessageThread messages={[failed]} canRetry={false} />);
    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeInTheDocument();

    rerender(<MessageThread messages={[failed]} canRetry={true} />);
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeInTheDocument();
  });

  // NEW-3 fix (docs/test-report.md): mirrors the outbound-retry test above, but for a FAILED
  // INBOUND message — `handleRetry` must branch to `retryInboundMessageTranslation`, not
  // `retryConversationMessage`, for this direction (see message-thread.tsx's doc comment).
  it("shows a retry button for a FAILED inbound message and calls retryInboundMessageTranslation on click", async () => {
    const { retryInboundMessageTranslation, retryConversationMessage } = await import("@/server/actions/messages");
    const failedInbound = makeMessage({
      id: "m5",
      direction: "INBOUND",
      status: "FAILED",
      translatedText: null,
      originalText: "Bonjour, comment allez-vous?",
    });

    render(<MessageThread messages={[failedInbound]} canRetry={true} />);
    const retryButton = screen.getByRole("button", { name: /^retry$/i });
    expect(retryButton).toBeInTheDocument();

    fireEvent.click(retryButton);

    expect(retryInboundMessageTranslation).toHaveBeenCalledWith({ messageId: "m5" });
    expect(retryConversationMessage).not.toHaveBeenCalled();
  });

  it("renders a delivery-status badge for outbound messages", () => {
    render(<MessageThread messages={[makeMessage({ id: "m4", direction: "OUTBOUND", status: "DEAD_LETTER" })]} canRetry={false} />);
    expect(screen.getByText("Undeliverable")).toBeInTheDocument();
  });
});
