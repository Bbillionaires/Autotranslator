package com.autotranslator.gateway.util

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffRetryTest {

    @Test
    fun `succeeds immediately without retrying`() = runTest {
        var calls = 0
        val result = BackoffRetry.withBackoff<String> {
            calls++
            BackoffRetry.RetryOutcome.Success("ok")
        }
        assertEquals(1, calls)
        assertEquals(BackoffRetry.RetryOutcome.Success("ok"), result)
    }

    @Test
    fun `stops immediately on a terminal outcome, never retrying`() = runTest {
        var calls = 0
        val result = BackoffRetry.withBackoff<String> {
            calls++
            BackoffRetry.RetryOutcome.Terminal("unauthorized")
        }
        assertEquals(1, calls)
        assertEquals(BackoffRetry.RetryOutcome.Terminal("unauthorized"), result)
    }

    @Test
    fun `retries a retryable outcome up to maxAttempts then gives up`() = runTest {
        var calls = 0
        val result = BackoffRetry.withBackoff<String>(maxAttempts = 3, baseDelayMillis = 1) {
            calls++
            BackoffRetry.RetryOutcome.Retryable("network error")
        }
        assertEquals(3, calls)
        assertEquals(BackoffRetry.RetryOutcome.Retryable("network error"), result)
    }

    @Test
    fun `succeeds after a couple of retryable failures`() = runTest {
        var calls = 0
        val result = BackoffRetry.withBackoff<String>(maxAttempts = 5, baseDelayMillis = 1) {
            calls++
            if (calls < 3) {
                BackoffRetry.RetryOutcome.Retryable("temporary")
            } else {
                BackoffRetry.RetryOutcome.Success("recovered")
            }
        }
        assertEquals(3, calls)
        assertEquals(BackoffRetry.RetryOutcome.Success("recovered"), result)
    }
}
