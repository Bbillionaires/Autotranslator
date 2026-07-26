/**
 * Tests for the security-headers middleware (H1 fix, docs/review-report.md). Asserts both
 * that every required header is present on the response AND that the request itself passes
 * through untouched (specifically: a webhook-shaped POST with a JSON body is not consumed
 * or altered by the middleware — headers-only, per the module doc comment).
 */
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

describe("security headers middleware", () => {
  it("sets every required security header on a plain GET request", () => {
    const req = new NextRequest("https://app.example.com/inbox");
    const res = middleware(req);

    expect(res.headers.get("Strict-Transport-Security")).toMatch(/max-age=\d+/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("still sets the same headers on a webhook-shaped POST request, without consuming/altering the request body", async () => {
    const body = JSON.stringify({ update_id: 1, message: { text: "hello" } });
    const req = new NextRequest("https://app.example.com/api/channels/telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "some-secret" },
      body,
    });

    const res = middleware(req);

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBeTruthy();

    // The middleware must not have consumed the request's body stream — it should still be
    // readable by whatever runs next (the actual route handler), exactly as sent.
    expect(await req.text()).toBe(body);
  });

  it("is a no-op pass-through — NextResponse.next() carries no redirect/rewrite, just extra headers", () => {
    const req = new NextRequest("https://app.example.com/settings");
    const res = middleware(req);

    expect(res.status).toBe(200);
    // "next" responses signal continuation via this internal header rather than a real redirect.
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
