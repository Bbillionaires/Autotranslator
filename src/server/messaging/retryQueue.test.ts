import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "../errors";
import {
  DEFAULT_RETRY_POLICY,
  assertValidTransition,
  canTransition,
  computeBackoffDelayMs,
  countScheduledRetryAttempts,
  nextRetryDecision,
  parseScheduledFor,
  runRetryWorkerOnce,
} from "./retryQueue";

describe("computeBackoffDelayMs", () => {
  it("computes base*2^(attempt-1) at the low end of jitter (random -> 0 => 50% factor)", () => {
    const random = () => 0;
    expect(computeBackoffDelayMs(1, DEFAULT_RETRY_POLICY, random)).toBe(1000); // 2000 * 0.5
    expect(computeBackoffDelayMs(2, DEFAULT_RETRY_POLICY, random)).toBe(2000); // 4000 * 0.5
    expect(computeBackoffDelayMs(3, DEFAULT_RETRY_POLICY, random)).toBe(4000); // 8000 * 0.5
    expect(computeBackoffDelayMs(4, DEFAULT_RETRY_POLICY, random)).toBe(8000); // 16000 * 0.5
    expect(computeBackoffDelayMs(5, DEFAULT_RETRY_POLICY, random)).toBe(16000); // 32000 * 0.5
  });

  it("computes base*2^(attempt-1) at the high end of jitter (random -> ~1 => ~100% factor)", () => {
    const random = () => 0.999999;
    expect(computeBackoffDelayMs(1, DEFAULT_RETRY_POLICY, random)).toBeCloseTo(2000, -1);
    expect(computeBackoffDelayMs(3, DEFAULT_RETRY_POLICY, random)).toBeCloseTo(8000, -1);
  });

  it("always stays within [50%, 100%] of the unjittered exponential value", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const delay = computeBackoffDelayMs(4, DEFAULT_RETRY_POLICY, () => r);
      const exponential = DEFAULT_RETRY_POLICY.baseDelayMs * 2 ** 3;
      expect(delay).toBeGreaterThanOrEqual(exponential * 0.5);
      expect(delay).toBeLessThanOrEqual(exponential);
    }
  });

  it("rejects attempt < 1", () => {
    expect(() => computeBackoffDelayMs(0)).toThrow();
  });
});

describe("nextRetryDecision", () => {
  const random = () => 0; // pin jitter to the deterministic low end for exact assertions

  it("returns PENDING with attempt 1 and ~1s delay for the first failure (previousAttempts=0)", () => {
    const decision = nextRetryDecision(0, DEFAULT_RETRY_POLICY, random);
    expect(decision).toEqual({ attempt: 1, delayMs: 1000, status: "PENDING" });
  });

  it("walks through the full backoff sequence up to the attempt cap", () => {
    const delays: number[] = [];
    let previousAttempts = 0;
    for (let i = 0; i < DEFAULT_RETRY_POLICY.maxAttempts; i += 1) {
      const decision = nextRetryDecision(previousAttempts, DEFAULT_RETRY_POLICY, random);
      expect(decision.status).toBe("PENDING");
      delays.push(decision.delayMs);
      previousAttempts = decision.attempt;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("moves to DEAD_LETTER once previousAttempts reaches the cap (5)", () => {
    const decision = nextRetryDecision(DEFAULT_RETRY_POLICY.maxAttempts, DEFAULT_RETRY_POLICY, random);
    expect(decision).toEqual({ attempt: DEFAULT_RETRY_POLICY.maxAttempts, delayMs: 0, status: "DEAD_LETTER" });
  });

  it("simulates repeated transient failures reaching DEAD_LETTER after exactly maxAttempts retries", () => {
    let attempts = 0;
    let status: "PENDING" | "DEAD_LETTER" = "PENDING";
    let iterations = 0;
    while (status === "PENDING" && iterations < 100) {
      const decision = nextRetryDecision(attempts, DEFAULT_RETRY_POLICY, random);
      status = decision.status;
      if (status === "PENDING") attempts = decision.attempt;
      iterations += 1;
    }
    expect(status).toBe("DEAD_LETTER");
    expect(attempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
  });
});

describe("MessageStatus transitions", () => {
  it("allows the documented forward-progress transitions", () => {
    expect(canTransition("QUEUED", "PENDING")).toBe(true);
    expect(canTransition("PENDING", "SENT")).toBe(true);
    expect(canTransition("SENT", "DELIVERED")).toBe(true);
    expect(canTransition("DELIVERED", "READ")).toBe(true);
    expect(canTransition("FAILED", "PENDING")).toBe(true);
    expect(canTransition("FAILED", "DEAD_LETTER")).toBe(true);
    expect(canTransition("DEAD_LETTER", "PENDING")).toBe(true);
  });

  it("rejects DELIVERED -> PENDING", () => {
    expect(canTransition("DELIVERED", "PENDING")).toBe(false);
    expect(() => assertValidTransition("DELIVERED", "PENDING")).toThrow(ConflictError);
  });

  it("rejects READ -> anything (terminal state)", () => {
    expect(canTransition("READ", "PENDING")).toBe(false);
    expect(canTransition("READ", "SENT")).toBe(false);
  });

  it("rejects skipping backwards from SENT to QUEUED", () => {
    expect(canTransition("SENT", "QUEUED")).toBe(false);
  });

  it("allows a same-status no-op transition", () => {
    expect(canTransition("PENDING", "PENDING")).toBe(true);
    expect(() => assertValidTransition("SENT", "SENT")).not.toThrow();
  });
});

describe("countScheduledRetryAttempts / parseScheduledFor", () => {
  it("counts only retry_scheduled events", () => {
    const events = [
      { eventType: "sent", payload: null, createdAt: new Date() },
      { eventType: "retry_scheduled", payload: { attempt: 1 }, createdAt: new Date() },
      { eventType: "retry_scheduled", payload: { attempt: 2 }, createdAt: new Date() },
    ];
    expect(countScheduledRetryAttempts(events)).toBe(2);
  });

  it("parses a valid scheduledFor timestamp", () => {
    const when = new Date("2026-01-01T00:00:00Z");
    const parsed = parseScheduledFor({
      eventType: "retry_scheduled",
      payload: { scheduledFor: when.toISOString() },
      createdAt: new Date(),
    });
    expect(parsed?.getTime()).toBe(when.getTime());
  });

  it("returns null for a missing/malformed payload", () => {
    expect(parseScheduledFor(null)).toBeNull();
    expect(parseScheduledFor({ eventType: "retry_scheduled", payload: null, createdAt: new Date() })).toBeNull();
    expect(
      parseScheduledFor({ eventType: "retry_scheduled", payload: { scheduledFor: "not-a-date" }, createdAt: new Date() }),
    ).toBeNull();
  });
});

describe("runRetryWorkerOnce", () => {
  it("retries only messages whose scheduled retry time has passed, and messages with no schedule at all", () => {
    const now = new Date("2026-01-01T00:10:00Z");
    const dueMessage = { id: "msg_due", events: [{ eventType: "retry_scheduled", payload: { scheduledFor: "2026-01-01T00:00:00Z" }, createdAt: new Date() }] };
    const notYetDueMessage = { id: "msg_not_due", events: [{ eventType: "retry_scheduled", payload: { scheduledFor: "2026-01-01T01:00:00Z" }, createdAt: new Date() }] };
    const neverScheduledMessage = { id: "msg_no_schedule", events: [] };

    const retryMessage = vi.fn().mockResolvedValue(undefined);

    return runRetryWorkerOnce({
      findFailedAwaitingRetry: async () => [dueMessage, notYetDueMessage, neverScheduledMessage],
      retryMessage,
      now: () => now,
    }).then((result) => {
      expect(retryMessage).toHaveBeenCalledWith("msg_due");
      expect(retryMessage).toHaveBeenCalledWith("msg_no_schedule");
      expect(retryMessage).not.toHaveBeenCalledWith("msg_not_due");
      expect(result).toEqual({ attempted: 2, succeeded: 2, failed: 0 });
    });
  });

  it("counts a per-message failure without throwing or stopping the batch", async () => {
    const messages = [{ id: "msg_a", events: [] }, { id: "msg_b", events: [] }];
    const retryMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const result = await runRetryWorkerOnce({
      findFailedAwaitingRetry: async () => messages,
      retryMessage,
    });

    expect(retryMessage).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ attempted: 2, succeeded: 1, failed: 1 });
  });

  it("does nothing when there are no candidate messages", async () => {
    const retryMessage = vi.fn();
    const result = await runRetryWorkerOnce({ findFailedAwaitingRetry: async () => [], retryMessage });
    expect(retryMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
  });
});
