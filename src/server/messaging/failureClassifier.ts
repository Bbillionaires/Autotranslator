/**
 * Pure classifier: transient vs permanent adapter failure, per
 * docs/implementation-plan.md §3.6 step 8 ("failures are classified transient (timeouts,
 * 5xx, rate limits) vs permanent (invalid recipient, permanently blocked, malformed
 * payload)"). `outboundService.ts` calls this after `adapter.sendMessage()` throws, to
 * decide whether the automatic retry worker should ever pick the message back up.
 *
 * Adapters (real ones, in Phases 6/8/9) are expected to throw `UpstreamAdapterError` with
 * a `detail.transient: boolean` hint when they can tell (e.g. Telegram's 429 vs 400). This
 * classifier also understands a bare HTTP-style `status` on the thrown error as a
 * fallback, and defaults unknown/unrecognized errors to "transient" — retrying an
 * ambiguous failure is safer than silently giving up on it; a human still sees it surfaced
 * once it reaches DEAD_LETTER after the attempt cap.
 */
import { UpstreamAdapterError } from "../errors";

export type FailureClassification = "transient" | "permanent";

function classifyByHttpStatus(status: number): FailureClassification {
  if (status === 429) return "transient"; // rate limited
  if (status >= 500) return "transient"; // upstream 5xx
  if (status >= 400) return "permanent"; // bad request / invalid recipient / forbidden
  return "transient";
}

/** Classifies a thrown adapter error as "transient" (retry-worthy) or "permanent" (don't auto-retry). */
export function classifyAdapterFailure(error: unknown): FailureClassification {
  if (error instanceof UpstreamAdapterError) {
    const detail = error.detail as { transient?: boolean; status?: number } | undefined;
    if (typeof detail?.transient === "boolean") {
      return detail.transient ? "transient" : "permanent";
    }
    if (typeof detail?.status === "number") {
      return classifyByHttpStatus(detail.status);
    }
  }

  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      return classifyByHttpStatus(status);
    }
  }

  return "transient";
}
