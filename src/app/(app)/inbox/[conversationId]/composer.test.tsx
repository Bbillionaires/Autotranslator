// @vitest-environment jsdom
/**
 * Component tests for `Composer`, per the Phase 7 task brief: the review-before-send flow
 * ("draft shown before send, not sent immediately") and role-gated rendering (a Viewer-role
 * session — modeled here as `canSend={false}` — doesn't see the compose form at all; the
 * REAL security boundary is the server-side `requireRole` check inside
 * `sendConversationMessage`/`confirmAndSendConversationMessage` themselves, covered by
 * messages.test.ts's role-gating tests, not by this component).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const sendConversationMessageMock = vi.fn();
const confirmAndSendConversationMessageMock = vi.fn();
const recordTranslationEditMock = vi.fn();
vi.mock("@/server/actions/messages", () => ({
  sendConversationMessage: (...args: unknown[]) => sendConversationMessageMock(...args),
  confirmAndSendConversationMessage: (...args: unknown[]) => confirmAndSendConversationMessageMock(...args),
  recordTranslationEdit: (...args: unknown[]) => recordTranslationEditMock(...args),
}));
vi.mock("@/server/actions/conversations", () => ({
  addConversationInternalNote: vi.fn(),
}));

const { Composer } = await import("./composer");

describe("Composer", () => {
  it("does not render the compose form when canSend is false (role-gated UI)", () => {
    render(<Composer conversationId="c1" targetLanguage="es" reviewBeforeSendDefault={false} canSend={false} highRisk={false} />);
    expect(screen.queryByPlaceholderText(/type your reply/i)).not.toBeInTheDocument();
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument();
  });

  it("shows the automatic target-language indicator", () => {
    render(<Composer conversationId="c1" targetLanguage="es" reviewBeforeSendDefault={false} canSend={true} highRisk={false} />);
    expect(screen.getByText(/will be translated to/i)).toBeInTheDocument();
    expect(screen.getByText(/Spanish/)).toBeInTheDocument();
  });

  it("review-before-send: shows the translated draft and does NOT call confirmAndSend until the user confirms", async () => {
    sendConversationMessageMock.mockResolvedValue({
      ok: true,
      data: { message: { id: "m1", translatedText: "Hola", originalText: "Hello" }, outcome: "DRAFT" },
    });
    confirmAndSendConversationMessageMock.mockResolvedValue({
      ok: true,
      data: { message: { id: "m1", status: "SENT" }, outcome: "SENT" },
    });

    render(<Composer conversationId="c1" targetLanguage="es" reviewBeforeSendDefault={true} canSend={true} highRisk={false} />);

    fireEvent.change(screen.getByPlaceholderText(/type your reply/i), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await screen.findByText(/review the translation/i);
    expect(sendConversationMessageMock).toHaveBeenCalledWith({ conversationId: "c1", text: "Hello", reviewBeforeSend: true });
    // The draft is shown for review — the actual send must NOT have happened yet.
    expect(confirmAndSendConversationMessageMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /confirm & send/i }));
    await waitFor(() => expect(confirmAndSendConversationMessageMock).toHaveBeenCalledWith({ messageId: "m1" }));
  });

  it("shows a high-risk warning banner above the composer when highRisk is true", () => {
    render(<Composer conversationId="c1" targetLanguage="es" reviewBeforeSendDefault={false} canSend={true} highRisk={true} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/high-risk conversation/i);
  });
});
