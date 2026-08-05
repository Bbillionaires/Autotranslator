/**
 * Retry/backoff logic and the `MessageStatus` state machine, per
 * docs/implementation-plan.md §3.6 step 8.
 *
 * The schema (§4) has no dedicated "attempts"/"nextRetryAt" columns on `Message` — per the
 * plan, retry scheduling is driven by `MessageEvent` rows of type `"retry_scheduled"`
 * (payload `{ attempt, scheduledFor }`). This module's pure functions
 * (`computeBackoffDelayMs`, `nextRetryDecision`, `canTransition`/`assertValidTransition`)
 * have zero Prisma/env dependency and are unit-tested in isolation; `runRetryWorkerOnce`
 * is the "simple Postgres-polled worker" the plan calls for — it takes its DB reads and
 * its actual retry-attempt function as injected dependencies (rather than importing
 * `outboundService` directly) specifically to avoid a circular import between this module
 * and `outboundService.ts` (which imports the pure helpers from here).
 */
import type { MessageStatus } from "@prisma/client";
import { ConflictError } from "../errors";
import { logger } from "../logger";

export interface RetryPolicy {
  /** Base delay before the first retry attempt, in milliseconds. */
  baseDelayMs: number;
  /** Maximum number of retry attempts before moving to DEAD_LETTER. */
  maxAttempts: number;
}

/** Base 2s, cap 5 attempts — exactly as specified in §3.6 step 8. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { baseDelayMs: 2000, maxAttempts: 5 };

/**
 * Computes the (jittered) delay before retry attempt number `attempt` (1-indexed: attempt
 * 1 is the first retry after the original send failure). Exponential in `attempt`:
 * `baseDelayMs * 2^(attempt-1)`, jittered to a random value in `[50%, 100%)` of that
 * exponential value so many simultaneously-failing messages don't all retry in lockstep
 * ("thundering herd").  `random` is injectable so tests can assert exact bounds/sequence
 * deterministically instead of asserting on a range every time.
 */
export function computeBackoffDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  if (attempt < 1) {
    throw new Error(`attempt must be >= 1, got ${attempt}`);
  }
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const jitterFactor = 0.5 + random() * 0.5; // [0.5, 1.0)
  return Math.round(exponential * jitterFactor);
}

export interface RetryDecision {
  /** The attempt number this decision concerns (1-indexed). */
  attempt: number;
  /** Delay before making this attempt, in ms. 0 when `status` is DEAD_LETTER. */
  delayMs: number;
  /** "PENDING" => schedule and retry; "DEAD_LETTER" => attempt cap exceeded, give up automatically. */
  status: "PENDING" | "DEAD_LETTER";
}

/**
 * Given how many retry attempts have already been made (0 the first time a send fails),
 * decides whether another automatic retry is allowed and, if so, what delay to use.
 * Once `previousAttempts` reaches `policy.maxAttempts`, the message moves to
 * `DEAD_LETTER` instead of retrying again — this is the "cap 5 attempts" rule.
 */
export function nextRetryDecision(
  previousAttempts: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): RetryDecision {
  const attempt = previousAttempts + 1;
  if (attempt > policy.maxAttempts) {
    return { attempt: previousAttempts, delayMs: 0, status: "DEAD_LETTER" };
  }
  return { attempt, delayMs: computeBackoffDelayMs(attempt, policy, random), status: "PENDING" };
}

// ---------------------------------------------------------------------------
// MessageStatus state machine
// ---------------------------------------------------------------------------

/**
 * Valid forward transitions. Terminal states (`READ`) have none. `DEAD_LETTER` can only be
 * escaped via an explicit manual retry (moves back to `PENDING`) — never automatically.
 * `DELIVERED -> PENDING` is deliberately absent: once a channel has confirmed delivery, the
 * message can only move forward to `READ`, never back to an unsent state.
 *
 * `PENDING -> QUEUED` and `QUEUED -> SENT` (Phase 8): the Android SMS gateway's inverted
 * control flow (§3.2/§3.6) means `outboundService.confirmAndSend` transitions a freshly
 * translated `PENDING` message straight to `QUEUED` (not `SENT`) when `AndroidSmsAdapter`
 * reports `status: "QUEUED"` — the row only reaches `SENT` later, when the device calls
 * `POST /api/gateways/messages/:id/acknowledge`. `QUEUED -> FAILED` already existed (a
 * message can fail before ever being picked up by a device, e.g. a revoked device); the
 * device's `POST /api/gateways/messages/:id/fail` reuses that same transition via
 * `outboundService.handleSendFailure`.
 *
 * `PENDING -> DELIVERED` (T1 fix, docs/test-report.md): the inbound lifecycle
 * (`inboundService.processInboundMessage`) now stores its `Message` row as `PENDING`
 * *before* attempting `TranslationEngine.detectLanguage()`/`.translate()` (mirroring the
 * outbound "store first" discipline), so the original text is durable even if translation
 * fails. On a successful translation the row moves `PENDING -> DELIVERED` (inbound messages
 * are already delivered to us by definition — there is no separate "sent" step) — a
 * transition no outbound code path ever performs (outbound only ever reaches `DELIVERED`
 * via a channel's own delivery-status callback after `SENT`, per `deliveryStatusService.ts`),
 * so allowing it here does not loosen any outbound invariant in practice.
 */
const VALID_TRANSITIONS: Record<MessageStatus, readonly MessageStatus[]> = {
  QUEUED: ["PENDING", "SENT", "FAILED"],
  PENDING: ["SENT", "QUEUED", "FAILED", "DELIVERED"],
  SENT: ["DELIVERED", "FAILED"],
  DELIVERED: ["READ"],
  READ: [],
  FAILED: ["PENDING", "DEAD_LETTER"],
  DEAD_LETTER: ["PENDING"],
};

/** True if `from -> to` is a valid transition (a no-op `from === to` is always allowed). */
export function canTransition(from: MessageStatus, to: MessageStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throws `ConflictError` if `from -> to` is not a valid `MessageStatus` transition. */
export function assertValidTransition(from: MessageStatus, to: MessageStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(`Invalid message status transition: ${from} -> ${to}`, { from, to });
  }
}

// ---------------------------------------------------------------------------
// Attempt-count derivation (pure, given a plain event list — no Prisma dependency)
// ---------------------------------------------------------------------------

export interface RetryScheduledEventLike {
  eventType: string;
  payload: unknown;
  createdAt: Date;
}

/** Number of retry attempts already scheduled for a message, derived from its `retry_scheduled` MessageEvent history. */
export function countScheduledRetryAttempts(events: RetryScheduledEventLike[]): number {
  return events.filter((event) => event.eventType === "retry_scheduled").length;
}

/** Parses the `scheduledFor` timestamp out of a `retry_scheduled` MessageEvent's JSON payload, if present and valid. */
export function parseScheduledFor(event: RetryScheduledEventLike | null | undefined): Date | null {
  if (!event) return null;
  const payload = event.payload as { scheduledFor?: string } | null;
  const scheduledFor = payload?.scheduledFor ? new Date(payload.scheduledFor) : null;
  return scheduledFor && !Number.isNaN(scheduledFor.getTime()) ? scheduledFor : null;
}

// ---------------------------------------------------------------------------
// Postgres-polled worker
// ---------------------------------------------------------------------------

export interface RetryableMessageLike {
  id: string;
  events: RetryScheduledEventLike[];
}

export interface RunRetryWorkerDeps {
  /** Fetches org-scoped FAILED messages with their `retry_scheduled` event history attached. */
  findFailedAwaitingRetry: () => Promise<RetryableMessageLike[]>;
  /** Actually re-attempts sending a message (typically `outboundService.retryMessage`). Injected to avoid a circular import. */
  retryMessage: (messageId: string) => Promise<unknown>;
  now?: () => Date;
}

export interface RunRetryWorkerResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

/**
 * One polling pass of the retry worker: fetches `FAILED` messages, filters to the ones
 * whose most recent `retry_scheduled` event's `scheduledFor` has passed (or which have no
 * scheduled-retry event at all, i.e. becoming eligible immediately), and calls the
 * injected `retryMessage` for each. A literal always-on cron/background process does not
 * need to be running in this sandbox — this function just needs to be correct and
 * callable (e.g. from a future cron entrypoint or manual admin action).
 */
export async function runRetryWorkerOnce(deps: RunRetryWorkerDeps): Promise<RunRetryWorkerResult> {
  const now = (deps.now ?? (() => new Date()))();
  const candidates = await deps.findFailedAwaitingRetry();

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  for (const message of candidates) {
    const latestSchedule = message.events[0] ?? null;
    const scheduledFor = parseScheduledFor(latestSchedule);
    const isDue = !scheduledFor || scheduledFor.getTime() <= now.getTime();
    if (!isDue) continue;

    attempted += 1;
    try {
      await deps.retryMessage(message.id);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ err: error, messageId: message.id }, "Retry worker: retryMessage attempt failed");
    }
  }

  return { attempted, succeeded, failed };
}
