package com.autotranslator.gateway.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.autotranslator.gateway.R
import java.text.DateFormat
import java.util.Date

/**
 * README's own suggested minimum status surface: "the app should independently show its own
 * 'last successfully synced' timestamp so an on-site operator can tell at a glance if the OS
 * has throttled it, without needing dashboard access."
 */
@Composable
fun StatusScreen(
    uiState: GatewayUiState,
    onTestConnection: () -> Unit,
    onStartService: () -> Unit,
    onStopService: () -> Unit,
    onReplaceDevice: () -> Unit,
    onOpenBatterySettings: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(stringResource(R.string.status_title), style = MaterialTheme.typography.headlineSmall)

        if (uiState.revoked) {
            Text(
                stringResource(R.string.status_revoked),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        } else {
            Text(
                "${stringResource(R.string.status_registered)} — ${uiState.deviceLabel ?: ""}",
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(uiState.baseUrl ?: "", style = MaterialTheme.typography.bodySmall)
        }

        HorizontalDivider()

        Text(
            if (uiState.serviceRunning) stringResource(R.string.status_service_running) else stringResource(R.string.status_service_stopped),
            style = MaterialTheme.typography.titleMedium,
        )

        Text(
            stringResource(R.string.status_last_heartbeat_label) + ": " + formatHeartbeat(uiState.lastHeartbeatAtEpochMillis),
            style = MaterialTheme.typography.bodyMedium,
        )

        if (uiState.serviceRunning) {
            OutlinedButton(onClick = onStopService, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.status_stop_button))
            }
        } else if (!uiState.revoked) {
            Button(onClick = onStartService, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.status_start_button))
            }
        }

        HorizontalDivider()

        Button(onClick = onTestConnection, enabled = !uiState.testInProgress, modifier = Modifier.fillMaxWidth()) {
            if (uiState.testInProgress) {
                CircularProgressIndicator(modifier = Modifier.padding(end = 8.dp))
            }
            Text(stringResource(R.string.status_test_connection_button))
        }
        uiState.testResult?.let { result ->
            val isOk = result == "ok"
            Text(
                if (isOk) stringResource(R.string.status_test_result_ok) else stringResource(R.string.status_test_result_fail, result),
                color = if (isOk) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        HorizontalDivider()

        OutlinedButton(onClick = onOpenBatterySettings, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.status_battery_button))
        }

        TextButton(onClick = onReplaceDevice, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.status_replace_token_button))
        }
    }
}

private fun formatHeartbeat(epochMillis: Long): String =
    if (epochMillis <= 0L) {
        "Never"
    } else {
        DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.MEDIUM).format(Date(epochMillis))
    }
