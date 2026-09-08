package com.autotranslator.gateway.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.autotranslator.gateway.data.GatewayConfigStore
import com.autotranslator.gateway.network.ApiResult
import com.autotranslator.gateway.network.GatewayApiClient
import com.autotranslator.gateway.service.GatewayForegroundService
import com.autotranslator.gateway.util.GatewayStatusBus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class GatewayUiState(
    val hasCredentials: Boolean = false,
    val baseUrl: String? = null,
    val deviceLabel: String? = null,
    val revoked: Boolean = false,
    val serviceRunning: Boolean = false,
    val lastHeartbeatAtEpochMillis: Long = -1L,
    val testInProgress: Boolean = false,
    val testResult: String? = null,
)

/**
 * Bridges [GatewayConfigStore] (persisted config), [GatewayStatusBus] (the running
 * service's live status), and the "test connection" one-off action into a single
 * [GatewayUiState] the Compose screens observe.
 */
class GatewayViewModel(application: Application) : AndroidViewModel(application) {

    private val configStore = GatewayConfigStore(application)
    private val testResult = MutableStateFlow<String?>(null)
    private val testInProgress = MutableStateFlow(false)
    /** Bumped after any write to [configStore] so [uiState] re-reads its latest values. */
    private val configVersion = MutableStateFlow(0)

    val uiState: StateFlow<GatewayUiState> = combine(
        GatewayStatusBus.state,
        testResult,
        testInProgress,
        configVersion,
    ) { status, latestTestResult, isTesting, _ ->
        GatewayUiState(
            hasCredentials = configStore.hasCredentials,
            baseUrl = configStore.baseUrl,
            deviceLabel = configStore.deviceLabel,
            revoked = configStore.revoked || status.revoked,
            serviceRunning = status.serviceRunning,
            lastHeartbeatAtEpochMillis = maxOf(configStore.lastHeartbeatAtEpochMillis, status.lastHeartbeatAtEpochMillis),
            testInProgress = isTesting,
            testResult = latestTestResult,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), GatewayUiState())

    /** Returns false if either field was blank — the setup screen shows a validation error. */
    fun saveCredentials(baseUrl: String, deviceToken: String, deviceLabel: String): Boolean {
        if (baseUrl.isBlank() || deviceToken.isBlank()) return false
        configStore.saveCredentials(baseUrl, deviceToken, deviceLabel.ifBlank { "This device" })
        configVersion.update { it + 1 }
        GatewayForegroundService.start(getApplication())
        return true
    }

    /** README: a revoked/replaced device needs a brand-new registration — start over. */
    fun clearCredentialsAndStop() {
        GatewayForegroundService.stop(getApplication())
        configStore.clearCredentials()
        configVersion.update { it + 1 }
    }

    fun startService() = GatewayForegroundService.start(getApplication())
    fun stopService() = GatewayForegroundService.stop(getApplication())

    fun setPreferredSubscriptionId(subscriptionId: Int) {
        configStore.preferredSubscriptionId = subscriptionId
        configVersion.update { it + 1 }
    }

    /** Manual "test connection" — a single heartbeat call, no retry (the user is watching). */
    fun testConnection() {
        if (!configStore.hasCredentials) return
        viewModelScope.launch {
            testInProgress.value = true
            testResult.value = null
            val client = GatewayApiClient(configStore.baseUrl!!, configStore.deviceToken!!)
            val result = client.heartbeat()
            testResult.value = when (result) {
                is ApiResult.Success -> "ok"
                is ApiResult.Unauthorized -> "unauthorized — this device may have been revoked"
                is ApiResult.RateLimited -> "rate limited — try again shortly"
                is ApiResult.NetworkFailure -> result.message
                is ApiResult.ServerError -> "server error (${result.code})"
                is ApiResult.ClientError -> "error ${result.code}: ${result.message}"
            }
            if (result is ApiResult.Success) {
                configStore.lastHeartbeatAtEpochMillis = System.currentTimeMillis()
                configVersion.update { it + 1 }
            }
            if (result is ApiResult.Unauthorized) {
                configStore.revoked = true
                configVersion.update { it + 1 }
            }
            testInProgress.value = false
        }
    }
}
