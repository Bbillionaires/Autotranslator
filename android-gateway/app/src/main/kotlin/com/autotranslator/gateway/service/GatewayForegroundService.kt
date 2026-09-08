package com.autotranslator.gateway.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.content.ContextCompat
import com.autotranslator.gateway.data.GatewayConfigStore
import com.autotranslator.gateway.data.PendingActionStore
import com.autotranslator.gateway.data.PendingInboundStore
import com.autotranslator.gateway.network.ApiResult
import com.autotranslator.gateway.network.GatewayApiClient
import com.autotranslator.gateway.network.dto.InboundRequest
import com.autotranslator.gateway.network.dto.PendingMessage
import com.autotranslator.gateway.util.BackoffRetry
import com.autotranslator.gateway.util.GatewayStatusBus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The persistent foreground service that IS this app's entire value proposition (README:
 * "This app's entire value proposition (reliably relaying SMS) depends on the poll/heartbeat
 * loop running continuously, so it MUST run as a foreground service").
 *
 * Runs two independent loops for as long as the service is alive:
 *   - a 60s heartbeat loop (`POST /api/gateways/heartbeat`)
 *   - a ~20s poll loop (`GET /api/gateways/messages/pending`, sending each via SmsManager,
 *     then acknowledging/failing) that also flushes both on-device retry queues
 *     ([PendingInboundStore], [PendingActionStore]) every cycle.
 *
 * **Why a plain coroutine loop instead of WorkManager for these**: WorkManager's minimum
 * periodic-work interval is 15 minutes — completely incompatible with this app's required
 * 60s heartbeat / 15-60s poll cadence (README §"Poll for outbound work" /
 * "Heartbeat periodically"). The "modest WorkManager-or-plain-loop" choice the build brief
 * calls out resolves to a plain loop for that reason; [BackoffRetry] supplies the
 * bounded-jittered-exponential-backoff behavior WorkManager would otherwise have given us,
 * scoped to each individual HTTP call instead of to a whole periodic job.
 */
class GatewayForegroundService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var heartbeatJob: Job? = null
    private var pollJob: Job? = null

    private lateinit var configStore: GatewayConfigStore
    private lateinit var pendingInboundStore: PendingInboundStore
    private lateinit var pendingActionStore: PendingActionStore
    private var apiClient: GatewayApiClient? = null

    /** Set from a 429 response; both loops skip their next few cycles until this passes. */
    @Volatile private var rateLimitedUntilMillis = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        configStore = GatewayConfigStore(applicationContext)
        pendingInboundStore = PendingInboundStore(applicationContext)
        pendingActionStore = PendingActionStore(applicationContext)
        GatewayNotifications.ensureChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Must call startForeground within 5s of being started, per Android's foreground
        // service deadline (README "Background service requirements") — do this before any
        // other work, including the credentials check below.
        startForeground(GatewayNotifications.NOTIFICATION_ID, GatewayNotifications.build(this, configStore.deviceLabel))

        if (!configStore.hasCredentials || configStore.revoked) {
            GatewayStatusBus.update { it.copy(serviceRunning = false, revoked = configStore.revoked) }
            stopSelf()
            return START_NOT_STICKY
        }

        apiClient = GatewayApiClient(configStore.baseUrl!!, configStore.deviceToken!!)
        GatewayStatusBus.update { it.copy(serviceRunning = true, revoked = false) }

        if (intent?.action == ACTION_FLUSH_INBOUND) {
            serviceScope.launch { flushPendingInbound() }
        }

        if (heartbeatJob?.isActive != true) {
            heartbeatJob = serviceScope.launch { heartbeatLoop() }
        }
        if (pollJob?.isActive != true) {
            pollJob = serviceScope.launch { pollLoop() }
        }

        // README: "restart on task removal if the user swipes the app away" — START_STICKY
        // covers the process-death case; onTaskRemoved (below) covers the explicit swipe-away
        // case on OEMs that treat it differently from a process kill.
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (configStore.hasCredentials && !configStore.revoked) {
            ContextCompat.startForegroundService(applicationContext, Intent(applicationContext, GatewayForegroundService::class.java))
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceScope.cancel()
        GatewayStatusBus.update { it.copy(serviceRunning = false) }
    }

    private fun isRateLimited(): Boolean = System.currentTimeMillis() < rateLimitedUntilMillis

    private fun markRateLimited() {
        // README: "429 should back off to at least the Retry-After-equivalent implied by the
        // rate limit window (60s) before trying again."
        rateLimitedUntilMillis = System.currentTimeMillis() + 60_000L
    }

    private fun onRevoked() {
        // README's "Authentication (device-side)": a 401 is terminal for this token — stop
        // polling/heartbeating and surface a clear disconnected state, never silently retry.
        configStore.revoked = true
        GatewayStatusBus.update { it.copy(revoked = true, serviceRunning = false) }
        heartbeatJob?.cancel()
        pollJob?.cancel()
        stopSelf()
    }

    // ---- heartbeat loop ----

    private suspend fun heartbeatLoop() {
        // `while (true)` rather than an isActive check: cancelling this coroutine's Job makes
        // the next `delay()` throw CancellationException, which unwinds the loop cleanly —
        // no separate liveness check needed.
        while (true) {
            if (!isRateLimited()) runCatching { doHeartbeatOnce() }
            delay(HEARTBEAT_INTERVAL_MS)
        }
    }

    private suspend fun doHeartbeatOnce() {
        val client = apiClient ?: return
        val outcome = BackoffRetry.withBackoff<Unit> { _ ->
            when (val result = client.heartbeat()) {
                is ApiResult.Success -> BackoffRetry.RetryOutcome.Success(Unit)
                is ApiResult.Unauthorized -> {
                    onRevoked()
                    BackoffRetry.RetryOutcome.Terminal("unauthorized")
                }
                is ApiResult.RateLimited -> {
                    markRateLimited()
                    BackoffRetry.RetryOutcome.Terminal("rate limited")
                }
                is ApiResult.NetworkFailure -> BackoffRetry.RetryOutcome.Retryable(result.message)
                is ApiResult.ServerError -> BackoffRetry.RetryOutcome.Retryable(result.message)
                is ApiResult.ClientError -> BackoffRetry.RetryOutcome.Terminal(result.message)
            }
        }
        if (outcome is BackoffRetry.RetryOutcome.Success) {
            val now = System.currentTimeMillis()
            configStore.lastHeartbeatAtEpochMillis = now
            GatewayStatusBus.update { it.copy(lastHeartbeatAtEpochMillis = now, lastError = null) }
        } else if (outcome is BackoffRetry.RetryOutcome.Retryable) {
            GatewayStatusBus.update { it.copy(lastError = outcome.message) }
        }
    }

    // ---- poll + send loop ----

    private suspend fun pollLoop() {
        while (true) {
            if (!isRateLimited()) {
                runCatching { flushPendingActions() }
                runCatching { flushPendingInbound() }
                runCatching { pollAndSendOnce() }
            }
            delay(POLL_INTERVAL_MS)
        }
    }

    private suspend fun pollAndSendOnce() {
        val client = apiClient ?: return
        val outcome = BackoffRetry.withBackoff(maxAttempts = 3) { _ ->
            when (val result = client.fetchPending(50)) {
                is ApiResult.Success -> BackoffRetry.RetryOutcome.Success(result.value.messages)
                is ApiResult.Unauthorized -> {
                    onRevoked()
                    BackoffRetry.RetryOutcome.Terminal("unauthorized")
                }
                is ApiResult.RateLimited -> {
                    markRateLimited()
                    BackoffRetry.RetryOutcome.Terminal("rate limited")
                }
                is ApiResult.NetworkFailure -> BackoffRetry.RetryOutcome.Retryable(result.message)
                is ApiResult.ServerError -> BackoffRetry.RetryOutcome.Retryable(result.message)
                is ApiResult.ClientError -> BackoffRetry.RetryOutcome.Terminal(result.message)
            }
        }
        val messages = (outcome as? BackoffRetry.RetryOutcome.Success)?.value ?: return
        for (message in messages) {
            sendOneMessage(message)
            // README "Carrier limitations": "Don't burst-send the entire pending queue with
            // no delay — space sends out by at least a second or two."
            delay(SEND_SPACING_MS)
        }
    }

    private suspend fun sendOneMessage(message: PendingMessage) {
        val outcome = SmsSendManager(applicationContext).send(message.to, message.text, configStore.preferredSubscriptionId)
        when (outcome) {
            is SmsSendManager.SendOutcome.Success -> acknowledgeOrQueue(message.id, externalMessageId = null)
            is SmsSendManager.SendOutcome.Failure -> failOrQueue(message.id, outcome.reason)
        }
    }

    private suspend fun acknowledgeOrQueue(messageId: String, externalMessageId: String?) {
        val client = apiClient
        if (client == null) {
            pendingActionStore.enqueue(PendingActionStore.Entry(PendingActionStore.Entry.Type.ACKNOWLEDGE, messageId, externalMessageId))
            return
        }
        val outcome = BackoffRetry.withBackoff(maxAttempts = 2) { _ ->
            when (val result = client.acknowledge(messageId, externalMessageId)) {
                is ApiResult.Success -> BackoffRetry.RetryOutcome.Success(Unit)
                is ApiResult.Unauthorized -> {
                    onRevoked()
                    BackoffRetry.RetryOutcome.Terminal("unauthorized")
                }
                is ApiResult.RateLimited -> {
                    markRateLimited()
                    BackoffRetry.RetryOutcome.Terminal("rate limited")
                }
                is ApiResult.NetworkFailure -> BackoffRetry.RetryOutcome.Retryable(result.message)
                is ApiResult.ServerError -> BackoffRetry.RetryOutcome.Retryable(result.message)
                is ApiResult.ClientError -> BackoffRetry.RetryOutcome.Terminal(result.message)
                // 404 (message belongs to another device, or unknown id) — nothing useful to
                // retry; drop it rather than queue it forever.
            }
        }
        if (outcome !is BackoffRetry.RetryOutcome.Success) {
            if (outcome is BackoffRetry.RetryOutcome.Retryable) {
                pendingActionStore.enqueue(PendingActionStore.Entry(PendingActionStore.Entry.Type.ACKNOWLEDGE, messageId, externalMessageId))
            }
        }
    }

    private suspend fun failOrQueue(messageId: String, reason: String) {
        val client = apiClient
        if (client == null) {
            pendingActionStore.enqueue(PendingActionStore.Entry(PendingActionStore.Entry.Type.FAIL, messageId, reason = reason))
            return
        }
        val outcome = BackoffRetry.withBackoff(maxAttempts = 2) { _ ->
            when (val result = client.fail(messageId, reason)) {
                is ApiResult.Success -> BackoffRetry.RetryOutcome.Success(Unit)
                is ApiResult.Unauthorized -> {
                    onRevoked()
                    BackoffRetry.RetryOutcome.Terminal("unauthorized")
                }
                is ApiResult.RateLimited -> {
                    markRateLimited()
                    BackoffRetry.RetryOutcome.Terminal("rate limited")
                }
                is ApiResult.NetworkFailure -> BackoffRetry.RetryOutcome.Retryable(result.message)
                is ApiResult.ServerError -> BackoffRetry.RetryOutcome.Retryable(result.message)
                is ApiResult.ClientError -> BackoffRetry.RetryOutcome.Terminal(result.message)
            }
        }
        if (outcome is BackoffRetry.RetryOutcome.Retryable) {
            pendingActionStore.enqueue(PendingActionStore.Entry(PendingActionStore.Entry.Type.FAIL, messageId, reason = reason))
        }
    }

    /** Retries any acknowledge/fail calls a previous cycle couldn't deliver. */
    private suspend fun flushPendingActions() {
        val client = apiClient ?: return
        val queued = pendingActionStore.peekAll()
        for (entry in queued) {
            val result = when (entry.type) {
                PendingActionStore.Entry.Type.ACKNOWLEDGE -> client.acknowledge(entry.messageId, entry.externalMessageId)
                PendingActionStore.Entry.Type.FAIL -> client.fail(entry.messageId, entry.reason ?: "UNKNOWN")
            }
            when (result) {
                is ApiResult.Success -> pendingActionStore.remove(entry.messageId)
                is ApiResult.ClientError -> pendingActionStore.remove(entry.messageId) // e.g. 404 — unrecoverable, stop retrying.
                is ApiResult.Unauthorized -> {
                    onRevoked()
                    return
                }
                is ApiResult.RateLimited -> {
                    markRateLimited()
                    return
                }
                is ApiResult.NetworkFailure, is ApiResult.ServerError -> Unit // leave queued, try again next cycle.
            }
        }
    }

    /** Retries any inbound SMS pushes a previous attempt couldn't deliver. */
    private suspend fun flushPendingInbound() {
        val client = apiClient ?: return
        val queued = pendingInboundStore.peekAll()
        for (entry in queued) {
            val request = InboundRequest(
                from = entry.from,
                text = entry.text,
                sentAt = entry.sentAt,
                externalMessageId = entry.externalMessageId,
            )
            when (client.pushInbound(request)) {
                is ApiResult.Success -> pendingInboundStore.remove(entry.externalMessageId)
                is ApiResult.ClientError -> pendingInboundStore.remove(entry.externalMessageId) // malformed payload — won't ever succeed.
                is ApiResult.Unauthorized -> {
                    onRevoked()
                    return
                }
                is ApiResult.RateLimited -> {
                    markRateLimited()
                    return
                }
                is ApiResult.NetworkFailure, is ApiResult.ServerError -> Unit // leave queued.
            }
        }
    }

    companion object {
        const val ACTION_FLUSH_INBOUND = "com.autotranslator.gateway.action.FLUSH_INBOUND"
        private const val HEARTBEAT_INTERVAL_MS = 60_000L
        private const val POLL_INTERVAL_MS = 20_000L
        private const val SEND_SPACING_MS = 1_500L

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, GatewayForegroundService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, GatewayForegroundService::class.java))
        }
    }
}
