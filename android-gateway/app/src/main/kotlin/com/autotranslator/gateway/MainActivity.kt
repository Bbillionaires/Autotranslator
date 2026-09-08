package com.autotranslator.gateway

import android.content.ActivityNotFoundException
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.autotranslator.gateway.ui.BatteryScreen
import com.autotranslator.gateway.ui.GatewayViewModel
import com.autotranslator.gateway.ui.SetupScreen
import com.autotranslator.gateway.ui.StatusScreen
import com.autotranslator.gateway.ui.theme.AndroidGatewayTheme
import com.autotranslator.gateway.util.BatteryOptimizationHelper
import com.autotranslator.gateway.util.PermissionUtils

class MainActivity : ComponentActivity() {

    private val viewModel: GatewayViewModel by viewModels()

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { /* re-checked reactively via PermissionUtils.hasAllRequiredPermissions in Compose below */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            AndroidGatewayTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

                    var hasAllPermissions by remember {
                        mutableStateOf(PermissionUtils.hasAllRequiredPermissions(this@MainActivity))
                    }
                    var showBatteryScreen by remember { mutableStateOf(false) }
                    var ignoringBatteryOptimizations by remember {
                        mutableStateOf(BatteryOptimizationHelper.isIgnoringBatteryOptimizations(this@MainActivity))
                    }

                    // Re-check permission/battery state whenever the user returns to the app
                    // (e.g. after granting a permission via the system dialog, or coming back
                    // from a manufacturer battery-settings screen).
                    val lifecycleOwner = LocalLifecycleOwner.current
                    DisposableEffect(lifecycleOwner) {
                        val observer = LifecycleEventObserver { _, event ->
                            if (event == Lifecycle.Event.ON_RESUME) {
                                hasAllPermissions = PermissionUtils.hasAllRequiredPermissions(this@MainActivity)
                                ignoringBatteryOptimizations = BatteryOptimizationHelper.isIgnoringBatteryOptimizations(this@MainActivity)
                            }
                        }
                        lifecycleOwner.lifecycle.addObserver(observer)
                        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
                    }

                    when {
                        showBatteryScreen -> BatteryScreen(
                            alreadyIgnoringOptimizations = ignoringBatteryOptimizations,
                            onRequestIgnoreOptimizations = {
                                try {
                                    startActivity(BatteryOptimizationHelper.buildIgnoreBatteryOptimizationsIntent(this@MainActivity))
                                } catch (_: ActivityNotFoundException) {
                                    startActivity(BatteryOptimizationHelper.buildAppDetailsSettingsIntent(this@MainActivity))
                                }
                            },
                            onOpenManufacturerSettings = {
                                val intent = BatteryOptimizationHelper.buildManufacturerBatterySettingsIntent()
                                try {
                                    if (intent != null) startActivity(intent) else throw ActivityNotFoundException()
                                } catch (_: Exception) {
                                    startActivity(BatteryOptimizationHelper.buildAppDetailsSettingsIntent(this@MainActivity))
                                }
                            },
                            onBack = { showBatteryScreen = false },
                        )

                        !uiState.hasCredentials || uiState.revoked -> SetupScreen(
                            revoked = uiState.revoked,
                            hasAllPermissions = hasAllPermissions,
                            onRequestPermissions = { permissionLauncher.launch(PermissionUtils.REQUIRED_RUNTIME_PERMISSIONS) },
                            onSave = { baseUrl, deviceToken, deviceLabel ->
                                viewModel.saveCredentials(baseUrl, deviceToken, deviceLabel)
                            },
                        )

                        else -> StatusScreen(
                            uiState = uiState,
                            onTestConnection = viewModel::testConnection,
                            onStartService = viewModel::startService,
                            onStopService = viewModel::stopService,
                            onReplaceDevice = viewModel::clearCredentialsAndStop,
                            onOpenBatterySettings = { showBatteryScreen = true },
                        )
                    }
                }
            }
        }
    }
}
