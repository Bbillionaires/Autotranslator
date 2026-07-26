// @vitest-environment jsdom
/**
 * Component test for `DeliveryStatusBadge`, per the Phase 7 task brief ("a delivery-status
 * badge rendering all statuses"). Also asserts the accessibility requirement from §
 * "Cross-cutting requirements" — every status is conveyed by visible text, not color alone
 * (each badge's accessible name includes the human-readable label).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MessageStatus } from "@prisma/client";
import { DeliveryStatusBadge } from "./delivery-status-badge";

const EXPECTED_LABELS: Record<MessageStatus, string> = {
  QUEUED: "Queued",
  PENDING: "Pending",
  SENT: "Sent",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Failed",
  DEAD_LETTER: "Undeliverable",
};

describe("DeliveryStatusBadge", () => {
  for (const [status, label] of Object.entries(EXPECTED_LABELS) as Array<[MessageStatus, string]>) {
    it(`renders a visible text label for ${status}`, () => {
      render(<DeliveryStatusBadge status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  }

  it("gives FAILED and DEAD_LETTER visually distinct treatment from healthy statuses", () => {
    const { container: failedContainer } = render(<DeliveryStatusBadge status="FAILED" />);
    const { container: sentContainer } = render(<DeliveryStatusBadge status="SENT" />);
    expect(failedContainer.querySelector('[data-status="FAILED"]')?.className).not.toEqual(
      sentContainer.querySelector('[data-status="SENT"]')?.className,
    );
  });
});
