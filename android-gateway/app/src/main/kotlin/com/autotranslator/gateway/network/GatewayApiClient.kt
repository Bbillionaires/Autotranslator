package com.autotranslator.gateway.network

import com.autotranslator.gateway.network.dto.AcknowledgeRequest
import com.autotranslator.gateway.network.dto.AcknowledgeResponse
import com.autotranslator.gateway.network.dto.FailRequest
import com.autotranslator.gateway.network.dto.FailResponse
import com.autotranslator.gateway.network.dto.GatewayErrorResponse
import com.autotranslator.gateway.network.dto.HeartbeatResponse
import com.autotranslator.gateway.network.dto.InboundRequest
import com.autotranslator.gateway.network.dto.InboundResponse
import com.autotranslator.gateway.network.dto.PendingMessagesResponse
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Thin OkHttp wrapper around the six `/api/gateways` Route Handlers this app talks to,
 * matched field-for-field against the Route Handlers under `src/app/api/gateways` and
 * `src/server/validation/androidGateway.ts` in the main repo (see network/dto/GatewayDtos.kt's
 * doc comment). Every method here performs exactly ONE HTTP attempt and returns an
 * [ApiResult] describing the outcome — retrying belongs to the caller (see
 * [com.autotranslator.gateway.util.BackoffRetry] and README's "Retry behavior" section for
 * why retry policy differs by outcome: 401 is terminal, 429 needs a longer specific backoff,
 * network/5xx failures get the generic jittered exponential backoff).
 *
 * Every request carries `Authorization: Bearer <deviceToken>` — the exact header format
 * `src/server/gateways/androidAuth.ts`'s `extractBearerToken` expects (`^Bearer\s+(.+)$`).
 * There is no token refresh; the token is entered once by the operator (see
 * [com.autotranslator.gateway.data.GatewayConfigStore]) and never rotated by this app.
 */
class GatewayApiClient(
    private val baseUrl: String,
    private val deviceToken: String,
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    private fun url(path: String): String = "$baseUrl$path"

    private fun requestBuilder(path: String): Request.Builder =
        Request.Builder()
            .url(url(path))
            .header("Authorization", "Bearer $deviceToken")
            .header("Accept", "application/json")

    /** Runs [block] against the raw OkHttp response and classifies the result uniformly. */
    private suspend fun <T> execute(request: Request, parseSuccess: (String) -> T): ApiResult<T> =
        withContext(Dispatchers.IO) {
            val response: Response
            try {
                response = client.newCall(request).execute()
            } catch (e: IOException) {
                return@withContext ApiResult.NetworkFailure(e.message ?: "network error")
            }

            response.use { resp ->
                val bodyText = try {
                    resp.body?.string().orEmpty()
                } catch (e: IOException) {
                    return@withContext ApiResult.NetworkFailure(e.message ?: "failed reading response body")
                }

                when (resp.code) {
                    in 200..299 -> {
                        try {
                            ApiResult.Success(parseSuccess(bodyText))
                        } catch (e: Exception) {
                            ApiResult.NetworkFailure("malformed response body: ${e.message}")
                        }
                    }
                    401 -> ApiResult.Unauthorized
                    429 -> ApiResult.RateLimited
                    in 500..599 -> ApiResult.ServerError(resp.code, errorMessage(bodyText))
                    else -> ApiResult.ClientError(resp.code, errorMessage(bodyText))
                }
            }
        }

    private fun errorMessage(bodyText: String): String =
        try {
            json.decodeFromString<GatewayErrorResponse>(bodyText).error
        } catch (_: Exception) {
            bodyText.ifBlank { "unknown error" }
        }

    /** `POST /api/gateways/heartbeat` — no request body. */
    suspend fun heartbeat(): ApiResult<HeartbeatResponse> {
        val request = requestBuilder("/api/gateways/heartbeat")
            .post("".toRequestBody(jsonMediaType))
            .build()
        return execute(request) { json.decodeFromString(it) }
    }

    /** `GET /api/gateways/messages/pending?limit=` */
    suspend fun fetchPending(limit: Int = 50): ApiResult<PendingMessagesResponse> {
        val request = requestBuilder("/api/gateways/messages/pending?limit=$limit").get().build()
        return execute(request) { json.decodeFromString(it) }
    }

    /** `POST /api/gateways/inbound` */
    suspend fun pushInbound(body: InboundRequest): ApiResult<InboundResponse> {
        val payload = json.encodeToString(body)
        val request = requestBuilder("/api/gateways/inbound")
            .post(payload.toRequestBody(jsonMediaType))
            .build()
        return execute(request) { json.decodeFromString(it) }
    }

    /** `POST /api/gateways/messages/:id/acknowledge` */
    suspend fun acknowledge(messageId: String, externalMessageId: String?): ApiResult<AcknowledgeResponse> {
        val payload = json.encodeToString(AcknowledgeRequest(externalMessageId))
        val request = requestBuilder("/api/gateways/messages/$messageId/acknowledge")
            .post(payload.toRequestBody(jsonMediaType))
            .build()
        return execute(request) { json.decodeFromString(it) }
    }

    /** `POST /api/gateways/messages/:id/fail` */
    suspend fun fail(messageId: String, reason: String): ApiResult<FailResponse> {
        val payload = json.encodeToString(FailRequest(reason))
        val request = requestBuilder("/api/gateways/messages/$messageId/fail")
            .post(payload.toRequestBody(jsonMediaType))
            .build()
        return execute(request) { json.decodeFromString(it) }
    }
}
