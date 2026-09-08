package com.autotranslator.gateway.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.autotranslator.gateway.MainActivity
import com.autotranslator.gateway.R

/**
 * The persistent, low-priority notification README requires for as long as the service is
 * alive: "This is not optional cosmetic polish — it's the mechanism Android uses to justify
 * not killing the process, and Play Store policy requires the user always be able to see
 * that SMS relaying is active."
 */
object GatewayNotifications {
    const val CHANNEL_ID = "gateway_status"
    const val NOTIFICATION_ID = 1001

    /** minSdk is 26 (Build.VERSION_CODES.O), so notification channels always exist — no SDK_INT gate needed. */
    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.notification_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    fun build(context: Context, deviceLabel: String?) = NotificationCompat.Builder(context, CHANNEL_ID)
        .setContentTitle(context.getString(R.string.notification_title))
        .setContentText(
            if (deviceLabel.isNullOrBlank()) {
                context.getString(R.string.notification_text_unconfigured)
            } else {
                context.getString(R.string.notification_text_format, deviceLabel)
            },
        )
        .setSmallIcon(R.drawable.ic_notification)
        .setOngoing(true)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setContentIntent(
            PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .build()
}
