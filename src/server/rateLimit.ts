/**
 * Rate limiting, per docs/implementation-plan.md §6.4: "A shared in-process/DB-backed
 * sliding-window limiter (upgradeable to Redis without an interface change) applied to:
 * all public/webhook-adjacent endpoints (.../api/gateways/*), ... Limits are per-IP for
 * anonymous endpoints and per-ChannelAccount/device for authenticated-device endpoints.
 * Exceeding the limit returns 429 with no detail beyond a generic message."
 *
 * No rate limiter existed anywhere in the codebase before this phase (checked: Phases
 * 3-7's webhook/route code has no rate-limit call) — this is the first one, built now
 * specifically to satisfy that requirement for the six Android gateway routes, but written
 * generically enough that Phase 9 (WhatsApp) or a future auth-endpoint pass can reuse it.
 *
 * Implementation: a fixed-window counter per key (not a sliding log) — the simplest correct
 * thing that satisfies "in-process, upgradeable to Redis without an interface change". A
 * key's count resets when its window elapses; `checkRateLimit` is a pure function of
 * `(store, key, policy, now)` so it's trivially unit-testable without timers/mocking
 * `Date.now()` globally. The module-level `gatewayRateLimiter` instance is what routes
 * actually import; tests exercise `checkRateLimit` directly against a fresh `Map` for
 * determinism.
 */

export interface RateLimitPolicy {
  /** Maximum requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface WindowState {
  count: number;
  windowStartedAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests remaining in the current window (0 when `allowed` is false). */
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

/**
 * Pure fixed-window rate-limit check against an injected store (a `Map` in production, a
 * fresh `Map` per test case for isolation). Mutates `store` to record this request when
 * `allowed` is true — a rejected request does NOT increment the count, so a client that
 * gets a 429 and (correctly) stops retrying doesn't keep digging itself further into the
 * window.
 */
export function checkRateLimit(
  store: Map<string, WindowState>,
  key: string,
  policy: RateLimitPolicy,
  now: number = Date.now(),
): RateLimitResult {
  const existing = store.get(key);

  if (!existing || now - existing.windowStartedAt >= policy.windowMs) {
    store.set(key, { count: 1, windowStartedAt: now });
    return { allowed: true, remaining: policy.limit - 1, resetAt: now + policy.windowMs };
  }

  const resetAt = existing.windowStartedAt + policy.windowMs;
  if (existing.count >= policy.limit) {
    return { allowed: false, remaining: 0, resetAt };
  }

  existing.count += 1;
  return { allowed: true, remaining: policy.limit - existing.count, resetAt };
}

/** Default policy for the Android gateway's per-device endpoints (heartbeat/inbound/pending/ack/fail). */
export const GATEWAY_DEVICE_RATE_LIMIT: RateLimitPolicy = { limit: 60, windowMs: 60_000 };

/** Tighter policy for `POST /api/gateways/register` (session-authenticated, but still worth throttling — an Administrator mis-scripting device provisioning shouldn't be able to spam ChannelAccount rows). */
export const GATEWAY_REGISTER_RATE_LIMIT: RateLimitPolicy = { limit: 10, windowMs: 60_000 };

/**
 * Process-wide store + convenience wrapper, used by the actual gateway Route Handlers.
 * Keyed by whatever the caller passes (typically the device's `ChannelAccount.id` for
 * per-device endpoints, or the session's `userId`/request IP for `/register`) — callers
 * choose the key, this class just owns the storage + policy application.
 */
export class RateLimiter {
  private readonly store = new Map<string, WindowState>();

  constructor(private readonly policy: RateLimitPolicy) {}

  check(key: string, now: number = Date.now()): RateLimitResult {
    return checkRateLimit(this.store, key, this.policy, now);
  }

  /** Test-only: drop all recorded windows. */
  reset(): void {
    this.store.clear();
  }
}

export const gatewayDeviceRateLimiter = new RateLimiter(GATEWAY_DEVICE_RATE_LIMIT);
export const gatewayRegisterRateLimiter = new RateLimiter(GATEWAY_REGISTER_RATE_LIMIT);

/** Standard 429 response body/status — no detail beyond a generic message, per §6.4/§6.8. */
export function rateLimitedResponse(): Response {
  return Response.json({ error: "Too many requests." }, { status: 429 });
}
