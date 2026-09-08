package com.autotranslator.gateway.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.autotranslator.gateway.data.GatewayConfigStore
import com.autotranslator.gateway.service.GatewayForegroundService

/**
 * README's "Background service requirements": "Restart on boot (RECEIVE_BOOT_COMPLETED + a
 * BroadcastReceiver that re-starts the foreground service) ... since a gateway phone is
 * typically a dedicated, unattended device — it should recover from every routine disruption
 * without a human physically walking over to it."
 */
class BootCompletedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val configStore = GatewayConfigStore(context.applicationContext)
        if (!configStore.hasCredentials || configStore.revoked) return

        ContextCompat.startForegroundService(
            context.applicationContext,
            Intent(context.applicationContext, GatewayForegroundService::class.java),
        )
    }
}
