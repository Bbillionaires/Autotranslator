/**
 * Unit tests for the fixed-window rate limiter (`checkRateLimit`/`RateLimiter`), per the
 * Phase 8 task brief's requirement for "at least a unit test on the limiter logic itself".
 * Pure function of `(store, key, policy, now)` — no timers/mocking `Date.now()` needed.
 */
import { describe, expect, it } from "vitest";
import { checkRateLimit, RateLimiter, type WindowState } from "./rateLimit";

describe("checkRateLimit", () => {
  const policy = { limit: 3, windowMs: 1000 };

  it("allows requests up to the limit within a window", () => {
    const store = new Map<string, WindowState>();
    const now = 1_000_000;

    expect(checkRateLimit(store, "device-1", policy, now).allowed).toBe(true);
    expect(checkRateLimit(store, "device-1", policy, now + 10).allowed).toBe(true);
    expect(checkRateLimit(store, "device-1", policy, now + 20).allowed).toBe(true);
  });

  it("rejects the request once the limit is exceeded within the same window", () => {
    const store = new Map<string, WindowState>();
    const now = 1_000_000;

    checkRateLimit(store, "device-1", policy, now);
    checkRateLimit(store, "device-1", policy, now + 10);
    checkRateLimit(store, "device-1", policy, now + 20);
    const fourth = checkRateLimit(store, "device-1", policy, now + 30);

    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
  });

  it("does not increment the count for a rejected request", () => {
    const store = new Map<string, WindowState>();
    const now = 1_000_000;
    checkRateLimit(store, "k", policy, now);
    checkRateLimit(store, "k", policy, now);
    checkRateLimit(store, "k", policy, now); // 3rd allowed, count === limit
    checkRateLimit(store, "k", policy, now); // rejected
    checkRateLimit(store, "k", policy, now); // still rejected, not further incremented

    expect(store.get("k")?.count).toBe(3);
  });

  it("resets the window once windowMs has elapsed", () => {
    const store = new Map<string, WindowState>();
    const now = 1_000_000;

    checkRateLimit(store, "k", policy, now);
    checkRateLimit(store, "k", policy, now);
    checkRateLimit(store, "k", policy, now);
    expect(checkRateLimit(store, "k", policy, now + 999).allowed).toBe(false);

    // Window elapsed -> fresh allowance.
    const afterWindow = checkRateLimit(store, "k", policy, now + 1000);
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.remaining).toBe(policy.limit - 1);
  });

  it("tracks independent keys independently", () => {
    const store = new Map<string, WindowState>();
    const now = 1_000_000;

    checkRateLimit(store, "device-a", policy, now);
    checkRateLimit(store, "device-a", policy, now);
    checkRateLimit(store, "device-a", policy, now);
    expect(checkRateLimit(store, "device-a", policy, now).allowed).toBe(false);

    // A different key has its own fresh budget.
    expect(checkRateLimit(store, "device-b", policy, now).allowed).toBe(true);
  });
});

describe("RateLimiter", () => {
  it("enforces its configured policy across .check() calls", () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
    const now = 5000;

    expect(limiter.check("x", now).allowed).toBe(true);
    expect(limiter.check("x", now).allowed).toBe(true);
    expect(limiter.check("x", now).allowed).toBe(false);
  });

  it("reset() clears all recorded windows", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
    const now = 5000;
    expect(limiter.check("x", now).allowed).toBe(true);
    expect(limiter.check("x", now).allowed).toBe(false);

    limiter.reset();
    expect(limiter.check("x", now).allowed).toBe(true);
  });
});
