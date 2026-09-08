// @vitest-environment jsdom
/**
 * Component tests for `TranslationDisclosureBanner` — M2 fix (docs/review-report.md).
 * Verifies the "dismissible but periodically re-shown" localStorage policy: visible with no
 * prior dismissal, hidden immediately after dismissing, and re-shown once the 7-day window
 * has elapsed since the last dismissal.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const STORAGE_KEY = "autotranslator:translationDisclosureDismissedAt";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const { TranslationDisclosureBanner } = await import("./translation-disclosure-banner");

describe("TranslationDisclosureBanner", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("shows the disclosure when never dismissed before", async () => {
    render(<TranslationDisclosureBanner />);
    await waitFor(() => expect(screen.getByText(/machine translation can make mistakes/i)).toBeInTheDocument());
  });

  it("hides immediately after clicking Dismiss, and records a dismissal timestamp", async () => {
    render(<TranslationDisclosureBanner />);
    await waitFor(() => expect(screen.getByText(/machine translation can make mistakes/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(screen.queryByText(/machine translation can make mistakes/i)).not.toBeInTheDocument();
    const stored = window.localStorage.getItem(STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(Number(stored)).toBeCloseTo(Date.now(), -2);
  });

  it("stays hidden on a fresh render shortly after a recent dismissal (within the 7-day window)", async () => {
    window.localStorage.setItem(STORAGE_KEY, String(Date.now() - 1000));

    render(<TranslationDisclosureBanner />);

    // Give the mount effect a tick to run, then assert it never renders.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText(/machine translation can make mistakes/i)).not.toBeInTheDocument();
  });

  it("re-shows once the 7-day re-show window has elapsed since the last dismissal", async () => {
    window.localStorage.setItem(STORAGE_KEY, String(Date.now() - SEVEN_DAYS_MS - 1000));

    render(<TranslationDisclosureBanner />);
    await waitFor(() => expect(screen.getByText(/machine translation can make mistakes/i)).toBeInTheDocument());
  });

  it("fails open (shows the banner) when the stored value is corrupt/non-numeric", async () => {
    window.localStorage.setItem(STORAGE_KEY, "not-a-number");

    render(<TranslationDisclosureBanner />);
    await waitFor(() => expect(screen.getByText(/machine translation can make mistakes/i)).toBeInTheDocument());
  });
});
