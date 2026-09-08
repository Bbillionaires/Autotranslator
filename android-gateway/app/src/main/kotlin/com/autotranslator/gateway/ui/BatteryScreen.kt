package com.autotranslator.gateway.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.autotranslator.gateway.R

@Composable
fun BatteryScreen(
    alreadyIgnoringOptimizations: Boolean,
    onRequestIgnoreOptimizations: () -> Unit,
    onOpenManufacturerSettings: () -> Unit,
    onBack: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(stringResource(R.string.battery_title), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.battery_body), style = MaterialTheme.typography.bodyMedium)

        if (alreadyIgnoringOptimizations) {
            Text("Stock Android battery optimization is already disabled for this app.", style = MaterialTheme.typography.bodyMedium)
        } else {
            Button(onClick = onRequestIgnoreOptimizations, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.battery_request_button))
            }
        }

        Button(onClick = onOpenManufacturerSettings, modifier = Modifier.fillMaxWidth()) {
            Text("Open manufacturer battery settings")
        }

        TextButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) {
            Text("Back")
        }
    }
}
