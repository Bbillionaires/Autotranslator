/**
 * Android gateway device-reported failure reasons, per the Phase 8 task brief:
 * "POST /messages/:id/fail — ... Zod: reason (enum of carrier/device error categories) ...
 * Feeds into Phase 5's failure classifier/retry logic (transient reasons -> retry path,
 * permanent reasons -> FAILED/DEAD_LETTER directly)."
 *
 * This is a small, standalone mapping (not `../messaging/failureClassifier.ts`, which
 * classifies *thrown adapter errors* by HTTP-style status) because a device-reported
 * failure has no HTTP status at all — it's a carrier/SIM/device condition the phone itself
 * observed. `toGatewayFailureError` bridges the two: it wraps a reason in an
 * `UpstreamAdapterError` carrying the right `detail.transient` hint, so
 * `outboundService.handleSendFailure` (which `classifyAdapterFailure` already knows how to
 * read) can be reused as-is for the retry-scheduling/DEAD_LETTER/MessageEvent logic — no
 * duplicated retry machinery between "adapter threw" and "device told us it failed".
 */
import { UpstreamAdapterError } from "../errors";

export const ANDROID_FAILURE_REASONS = ["NO_SIGNAL", "INVALID_NUMBER", "SIM_ERROR", "UNKNOWN"] as const;
export type AndroidFailureReason = (typeof ANDROID_FAILURE_REASONS)[number];

/**
 * `NO_SIGNAL`/`SIM_ERROR`: transient device/carrier conditions — worth an automatic retry
 * once the device is back on a network / the SIM issue clears. `INVALID_NUMBER`: permanent
 * — retrying won't ever succeed against a malformed/nonexistent number. `UNKNOWN`: defaults
 * to transient, mirroring `classifyAdapterFailure`'s own stated philosophy ("retrying an
 * ambiguous failure is safer than silently giving up on it; a human still sees it surfaced
 * once it reaches DEAD_LETTER after the attempt cap").
 */
const TRANSIENT_REASONS: ReadonlySet<AndroidFailureReason> = new Set(["NO_SIGNAL", "SIM_ERROR", "UNKNOWN"]);

export function isTransientFailureReason(reason: AndroidFailureReason): boolean {
  return TRANSIENT_REASONS.has(reason);
}

/** Builds the `UpstreamAdapterError` `outboundService.handleSendFailure` expects, from a device-reported failure reason. */
export function toGatewayFailureError(reason: AndroidFailureReason): UpstreamAdapterError {
  return new UpstreamAdapterError(`Android device reported a send failure: ${reason}`, {
    transient: isTransientFailureReason(reason),
    reason,
  });
}
