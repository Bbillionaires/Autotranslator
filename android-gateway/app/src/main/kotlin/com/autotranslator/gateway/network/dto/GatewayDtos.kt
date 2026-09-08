package com.autotranslator.gateway.network.dto

import kotlinx.serialization.Serializable

/**
 * Request/response shapes for the Route Handlers under `src/app/api/gateways` in the main
 * AutoTranslator repo.
 * Field names and optionality are matched exactly against those Route Handlers and
 * `src/server/validation/androidGateway.ts` — see that file and
 * `docs/channel-adapters.md`'s "Android SMS gateway" section for the source of truth this
 * was written against. This app never calls `POST /api/gateways/register` itself (see that
 * route's doc comment — it is session-authenticated, admin-only, called from the web
 * dashboard), so no request DTO for it exists here; only the device-token-authenticated
 * routes below are needed.
 */

// ---- POST /api/gateways/heartbeat ----
// Request body: none.
@Serializable
data class HeartbeatResponse(
    val ok: Boolean,
    val serverTime: String,
)

// ---- POST /api/gateways/inbound ----
@Serializable
data class InboundRequest(
    val from: String,
    val text: String,
    /** ISO-8601 instant; the server does `z.coerce.date()` on this. */
    val sentAt: String,
    val externalMessageId: String,
)

@Serializable
data class InboundResponse(
    val ok: Boolean,
    val messageId: String,
    val duplicate: Boolean,
)

// ---- GET /api/gateways/messages/pending ----
@Serializable
data class PendingMessage(
    val id: String,
    val to: String,
    val text: String,
    val createdAt: String,
)

@Serializable
data class PendingMessagesResponse(
    val messages: List<PendingMessage>,
)

// ---- POST /api/gateways/messages/:id/acknowledge ----
@Serializable
data class AcknowledgeRequest(
    val externalMessageId: String? = null,
)

@Serializable
data class AcknowledgeResponse(
    val ok: Boolean,
    val status: String,
)

// ---- POST /api/gateways/messages/:id/fail ----
@Serializable
data class FailRequest(
    /** One of NO_SIGNAL | INVALID_NUMBER | SIM_ERROR | UNKNOWN — see AndroidFailureReason. */
    val reason: String,
)

@Serializable
data class FailResponse(
    val ok: Boolean,
    val status: String,
    val outcome: String,
)

// ---- Generic error shape every gateway route collapses onto ----
// 401 { "error": "unauthorized" }, 429 { "error": "Too many requests." }, 400 { "error": ..., ... }
@Serializable
data class GatewayErrorResponse(
    val error: String,
)

/**
 * The four device-reported SMS send failure reasons the server accepts
 * (`src/server/gateways/androidFailureReasons.ts`'s `ANDROID_FAILURE_REASONS`). Kept as plain
 * string constants (not a Kotlin enum serialized by name) so a value here is guaranteed to be
 * exactly one of the server's accepted enum literals with no serialization-name mismatch risk.
 */
object AndroidFailureReason {
    const val NO_SIGNAL = "NO_SIGNAL"
    const val INVALID_NUMBER = "INVALID_NUMBER"
    const val SIM_ERROR = "SIM_ERROR"
    const val UNKNOWN = "UNKNOWN"
}
