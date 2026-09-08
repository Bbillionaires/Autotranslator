package com.autotranslator.gateway.network

/** Outcome of a single (non-retried) call to one gateway endpoint. */
sealed interface ApiResult<out T> {
    data class Success<T>(val value: T) : ApiResult<T>

    /** 401 — per androidAuth.ts, collapses every auth failure into this; terminal for this token. */
    data object Unauthorized : ApiResult<Nothing>

    /** 429 — per rateLimit.ts, 60 req/min per device; back off at least 60s before retrying. */
    data object RateLimited : ApiResult<Nothing>

    /** Timeout, DNS failure, no connectivity, or any other exception opening/using the connection. */
    data class NetworkFailure(val message: String) : ApiResult<Nothing>

    /** 5xx — transient, worth retrying with backoff. */
    data class ServerError(val code: Int, val message: String) : ApiResult<Nothing>

    /** 4xx other than 401/429 (e.g. 400 malformed body, 404 unknown message id) — not retryable. */
    data class ClientError(val code: Int, val message: String) : ApiResult<Nothing>
}
