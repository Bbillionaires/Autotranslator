package com.autotranslator.gateway.util

import kotlin.math.min
import kotlin.random.Random
import kotlinx.coroutines.delay

/**
 * Bounded, jittered exponential backoff for a single HTTP call, per README's "Retry behavior"
 * section: "Wrap every HTTP call ... in a short bounded-retry with jittered exponential
 * backoff (e.g. base 2s, cap ~5 attempts, cap total wait under the next poll interval) for
 * connectivity failures (timeout, DNS failure, 5xx). Do NOT retry a 401/429 the same way."
 *
 * This is intentionally a small local loop rather than WorkManager's own backoff policy —
 * WorkManager's minimum periodic-work interval is 15 minutes, far coarser than this app's
 * required 60s heartbeat / 15-60s poll cadence (see [com.autotranslator.gateway.service.GatewayForegroundService]'s
 * doc comment for that judgment call), so the retry has to live at the individual-call level
 * inside the foreground service's own loop instead.
 */
object BackoffRetry {

    /** [action] returns a [RetryOutcome] telling this loop whether to retry, stop, or succeed. */
    sealed interface RetryOutcome<out T> {
        data class Success<T>(val value: T) : RetryOutcome<T>
        /** A connectivity/5xx failure — worth retrying with backoff. */
        data class Retryable(val message: String) : RetryOutcome<Nothing>
        /** A 401, a permanent client error, or the attempt cap was reached — stop immediately. */
        data class Terminal(val message: String) : RetryOutcome<Nothing>
    }

    suspend fun <T> withBackoff(
        maxAttempts: Int = 5,
        baseDelayMillis: Long = 2_000,
        maxDelayMillis: Long = 30_000,
        action: suspend (attempt: Int) -> RetryOutcome<T>,
    ): RetryOutcome<T> {
        var attempt = 1
        while (true) {
            when (val outcome = action(attempt)) {
                is RetryOutcome.Success -> return outcome
                is RetryOutcome.Terminal -> return outcome
                is RetryOutcome.Retryable -> {
                    if (attempt >= maxAttempts) return outcome
                    val exponential = baseDelayMillis * (1L shl (attempt - 1))
                    val capped = min(exponential, maxDelayMillis)
                    val jitter = Random.nextLong(0, capped / 2 + 1)
                    delay(capped / 2 + jitter)
                    attempt += 1
                }
            }
        }
    }
}
