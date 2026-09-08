package com.autotranslator.gateway

import android.app.Application
import com.autotranslator.gateway.service.GatewayNotifications

class GatewayApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // Safe to create the notification channel at process start regardless of whether the
        // service is running yet — `createNotificationChannel` is idempotent.
        GatewayNotifications.ensureChannel(this)
    }
}
