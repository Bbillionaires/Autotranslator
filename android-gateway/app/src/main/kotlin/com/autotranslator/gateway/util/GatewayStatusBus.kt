package com.autotranslator.gateway.util

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * In-process shared status between [com.autotranslator.gateway.service.GatewayForegroundService]
 * (the writer) and the Compose UI (the reader) — both run in the app's default (single)
 * process, so a plain [MutableStateFlow] singleton is enough; no `LocalBroadcastManager`
 * (deprecated) or bound-service `Messenger`/AIDL plumbing is needed for a status readout this
 * simple.
 */
data class GatewayStatusSnapshot(
    val serviceRunning: Boolean = false,
    val revoked: Boolean = false,
    val lastHeartbeatAtEpochMillis: Long = -1L,
    val lastError: String? = null,
)

object GatewayStatusBus {
    private val _state = MutableStateFlow(GatewayStatusSnapshot())
    val state: StateFlow<GatewayStatusSnapshot> = _state.asStateFlow()

    fun update(transform: (GatewayStatusSnapshot) -> GatewayStatusSnapshot) {
        _state.update(transform)
    }
}
