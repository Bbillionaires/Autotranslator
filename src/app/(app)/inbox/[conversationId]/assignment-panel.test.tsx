// @vitest-environment jsdom
/**
 * Component test for `AssignmentPanel`'s role-gated rendering (Phase 7: "a Viewer-role
 * render doesn't show ... assignment controls"). The real security boundary is the
 * server-side `requireRole` check inside `assignConversation`/`changeConversationStatus`/
 * etc. (covered by conversations.test.ts), not this component — this test only verifies the
 * UI-hiding half of the requirement.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/server/actions/conversations", () => ({
  assignConversation: vi.fn(),
  changeConversationStatus: vi.fn(),
  setConversationHighRisk: vi.fn(),
  setConversationLanguageOverride: vi.fn(),
}));

const { AssignmentPanel } = await import("./assignment-panel");

const baseProps = {
  conversationId: "c1",
  status: "OPEN" as const,
  highRisk: false,
  assignedUserId: null,
  assignedTeamId: null,
  languageOverride: null,
  users: [{ id: "u1", name: "Alex Agent" }],
  teams: [{ id: "t1", name: "Support Team" }],
};

describe("AssignmentPanel", () => {
  it("hides assignment/status/high-risk controls for a read-only (Viewer) session", () => {
    render(<AssignmentPanel {...baseProps} canManage={false} />);
    expect(screen.queryByLabelText(/assigned to/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^status$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/mark as high-risk/i)).not.toBeInTheDocument();
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument();
  });

  it("shows assignment/status/high-risk controls for an Agent+ session", () => {
    render(<AssignmentPanel {...baseProps} canManage={true} />);
    expect(screen.getByLabelText(/assigned to/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^status$/i)).toBeInTheDocument();
    expect(screen.getByText(/mark as high-risk/i)).toBeInTheDocument();
  });
});
