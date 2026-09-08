package com.autotranslator.gateway.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.autotranslator.gateway.R

/**
 * README/`docs/channel-adapters.md`: an Administrator registers the device from the web
 * dashboard (`POST /api/gateways/register`, session-authenticated) and is shown a one-time
 * device token; this screen is where that token — and the server's base URL — are pasted in.
 * This app never calls `/register` itself.
 */
@Composable
fun SetupScreen(
    revoked: Boolean,
    hasAllPermissions: Boolean,
    onRequestPermissions: () -> Unit,
    onSave: (baseUrl: String, deviceToken: String, deviceLabel: String) -> Boolean,
) {
    var baseUrl by rememberSaveable { mutableStateOf("") }
    var deviceToken by rememberSaveable { mutableStateOf("") }
    var deviceLabel by rememberSaveable { mutableStateOf("") }
    var consentChecked by rememberSaveable { mutableStateOf(false) }
    var validationError by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(stringResource(R.string.setup_title), style = MaterialTheme.typography.headlineSmall)

        if (revoked) {
            Text(
                stringResource(R.string.status_revoked),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        Text(stringResource(R.string.setup_intro), style = MaterialTheme.typography.bodyMedium)

        OutlinedTextField(
            value = baseUrl,
            onValueChange = { baseUrl = it },
            label = { Text(stringResource(R.string.setup_base_url_label)) },
            placeholder = { Text(stringResource(R.string.setup_base_url_placeholder)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = deviceToken,
            onValueChange = { deviceToken = it },
            label = { Text(stringResource(R.string.setup_device_token_label)) },
            placeholder = { Text(stringResource(R.string.setup_device_token_placeholder)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = deviceLabel,
            onValueChange = { deviceLabel = it },
            label = { Text("Device label (shown in the status notification)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        HorizontalDivider()

        Text(stringResource(R.string.permission_rationale_title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.permission_rationale_body), style = MaterialTheme.typography.bodySmall)
        Button(onClick = onRequestPermissions, enabled = !hasAllPermissions) {
            Text(if (hasAllPermissions) "Permissions granted" else stringResource(R.string.permission_grant_button))
        }

        HorizontalDivider()

        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = consentChecked, onCheckedChange = { consentChecked = it })
            Text(stringResource(R.string.setup_consent_text), style = MaterialTheme.typography.bodySmall)
        }

        validationError?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }

        Button(
            onClick = {
                if (!hasAllPermissions) {
                    validationError = "Grant all permissions above before continuing."
                    return@Button
                }
                if (!consentChecked) {
                    validationError = "You must accept the SMS relay consent notice to continue."
                    return@Button
                }
                val saved = onSave(baseUrl, deviceToken, deviceLabel)
                validationError = if (saved) null else "Enter both the server URL and the device token."
            },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.setup_save_button))
        }
    }
}
