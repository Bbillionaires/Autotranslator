package com.autotranslator.gateway.util

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Exactly the permissions README's "Required Android permissions" table lists as needing a
 * runtime request (`ActivityCompat.requestPermissions`) — `INTERNET`/`ACCESS_NETWORK_STATE`/
 * `FOREGROUND_SERVICE*`/`RECEIVE_BOOT_COMPLETED` are install-time/normal permissions and
 * never appear here.
 */
object PermissionUtils {
    val REQUIRED_RUNTIME_PERMISSIONS: Array<String> = buildList {
        add(Manifest.permission.SEND_SMS)
        add(Manifest.permission.RECEIVE_SMS)
        add(Manifest.permission.READ_PHONE_STATE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }.toTypedArray()

    fun hasAllRequiredPermissions(context: Context): Boolean =
        REQUIRED_RUNTIME_PERMISSIONS.all {
            ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
        }
}
