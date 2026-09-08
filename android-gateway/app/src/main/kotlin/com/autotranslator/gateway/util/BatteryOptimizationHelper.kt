package com.autotranslator.gateway.util

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * README's "Battery-optimization considerations": request exemption from stock Android's
 * Doze/App Standby via `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, AND separately point
 * the operator at their OEM's own battery-manager screen ("there is no single API for this —
 * detect the manufacturer via Build.MANUFACTURER and deep-link or instruct accordingly").
 */
object BatteryOptimizationHelper {

    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return powerManager.isIgnoringBatteryOptimizations(context.packageName)
    }

    @SuppressLint("BatteryLife")
    fun buildIgnoreBatteryOptimizationsIntent(context: Context): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))

    /**
     * Best-effort deep link into the OEM's own battery manager screen. There is no stable,
     * documented API for this across manufacturers — these intents are widely used in the
     * community but may silently fail to resolve on a given firmware build; the caller must
     * catch [ActivityNotFoundException] and fall back to a plain-language instruction instead
     * (README explicitly calls out: "Samsung Device Care → Battery → App power management;
     * Xiaomi Security app → Battery → App battery saver → set to 'No restrictions'; Huawei
     * Phone Manager → Protected Apps; etc.").
     */
    fun buildManufacturerBatterySettingsIntent(): Intent? =
        when (Build.MANUFACTURER.lowercase()) {
            "xiaomi" -> Intent().setComponent(
                android.content.ComponentName(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.autostart.AutoStartManagementActivity",
                ),
            )
            "huawei" -> Intent().setComponent(
                android.content.ComponentName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                ),
            )
            "oppo" -> Intent().setComponent(
                android.content.ComponentName(
                    "com.coloros.safecenter",
                    "com.coloros.safecenter.permission.startup.StartupAppListActivity",
                ),
            )
            "vivo" -> Intent().setComponent(
                android.content.ComponentName(
                    "com.vivo.permissionmanager",
                    "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
                ),
            )
            "samsung" -> Intent().setComponent(
                android.content.ComponentName(
                    "com.samsung.android.lool",
                    "com.samsung.android.sm.battery.ui.BatteryActivity",
                ),
            )
            else -> null
        }

    /** Falls back to the generic app-details settings screen if nothing more specific applies. */
    fun buildAppDetailsSettingsIntent(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
}
