package com.autotranslator.gateway.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Persists the device's gateway configuration: the server base URL, the operator-entered
 * device token, and a device name label for the notification. Backed by an Android
 * Keystore-derived master key via [EncryptedSharedPreferences], per README's "Authentication
 * (device-side)" section: "must be stored in the Android Keystore-backed
 * EncryptedSharedPreferences ... never in plain SharedPreferences, a plain file, or logged
 * anywhere." The base URL isn't itself sensitive, but keeping it in the same encrypted store
 * as the token avoids a second storage mechanism for no real benefit.
 *
 * This class deliberately has no method that logs or otherwise surfaces the raw token — only
 * [deviceToken] (used for the Authorization header) and [hasCredentials] (a boolean) are
 * exposed for that value.
 */
class GatewayConfigStore(context: Context) {

    private val prefs: SharedPreferences = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        EncryptedSharedPreferences.create(
            context,
            PREFS_FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var baseUrl: String?
        get() = prefs.getString(KEY_BASE_URL, null)
        private set(value) = prefs.edit().putString(KEY_BASE_URL, value).apply()

    var deviceToken: String?
        get() = prefs.getString(KEY_DEVICE_TOKEN, null)
        private set(value) = prefs.edit().putString(KEY_DEVICE_TOKEN, value).apply()

    var deviceLabel: String?
        get() = prefs.getString(KEY_DEVICE_LABEL, null)
        private set(value) = prefs.edit().putString(KEY_DEVICE_LABEL, value).apply()

    /** Set once, `null` unless the device has ever received a `401` (see README: terminal). */
    var revoked: Boolean
        get() = prefs.getBoolean(KEY_REVOKED, false)
        set(value) = prefs.edit().putBoolean(KEY_REVOKED, value).apply()

    var lastHeartbeatAtEpochMillis: Long
        get() = prefs.getLong(KEY_LAST_HEARTBEAT, -1L)
        set(value) = prefs.edit().putLong(KEY_LAST_HEARTBEAT, value).apply()

    /** Operator-selected SIM subscription id for dual-SIM devices, or -1 for "use OS default". */
    var preferredSubscriptionId: Int
        get() = prefs.getInt(KEY_SUBSCRIPTION_ID, -1)
        set(value) = prefs.edit().putInt(KEY_SUBSCRIPTION_ID, value).apply()

    val hasCredentials: Boolean
        get() = !baseUrl.isNullOrBlank() && !deviceToken.isNullOrBlank()

    fun saveCredentials(baseUrl: String, deviceToken: String, deviceLabel: String) {
        val normalizedBaseUrl = baseUrl.trim().trimEnd('/')
        this.baseUrl = normalizedBaseUrl
        this.deviceToken = deviceToken.trim()
        this.deviceLabel = deviceLabel.trim()
        this.revoked = false
    }

    /** README: a revoked/replaced device gets a brand new token only by re-registering as "new". */
    fun clearCredentials() {
        prefs.edit()
            .remove(KEY_BASE_URL)
            .remove(KEY_DEVICE_TOKEN)
            .remove(KEY_DEVICE_LABEL)
            .remove(KEY_REVOKED)
            .remove(KEY_LAST_HEARTBEAT)
            .apply()
    }

    companion object {
        private const val PREFS_FILE_NAME = "gateway_secure_prefs"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_DEVICE_TOKEN = "device_token"
        private const val KEY_DEVICE_LABEL = "device_label"
        private const val KEY_REVOKED = "revoked"
        private const val KEY_LAST_HEARTBEAT = "last_heartbeat_epoch_millis"
        private const val KEY_SUBSCRIPTION_ID = "preferred_subscription_id"
    }
}
