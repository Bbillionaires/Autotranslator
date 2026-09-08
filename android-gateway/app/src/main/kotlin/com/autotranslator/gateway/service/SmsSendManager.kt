package com.autotranslator.gateway.service

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import com.autotranslator.gateway.network.dto.AndroidFailureReason
import kotlin.coroutines.resume
import kotlin.random.Random
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Sends one outbound SMS via [SmsManager] and reports back the REAL send outcome — per
 * README's "SMS send/receive workflow": "SmsManager's 'success' from the call itself only
 * means 'handed to the radio', not 'actually transmitted' ... Register a BroadcastReceiver
 * for the sentPI ... PendingIntent to learn the real send outcome asynchronously."
 *
 * Always uses [SmsManager.divideMessage] + `sendMultipartTextMessage` (never a bare
 * single-segment `sendTextMessage`) since translated text can be in any language/script and
 * silently truncating a reply is worse than sending it as several concatenated segments
 * (README's "Carrier limitations" section) — this is correct even when the text happens to
 * fit in one segment, since `divideMessage` on a short string just returns a single-element
 * list and `sendMultipartTextMessage` sends it exactly as `sendTextMessage` would.
 *
 * Delivery reports (the `deliveredPI` half of README's `sendTextMessage(...)` example) are
 * deliberately not requested here: this channel's terminal *tracked* status is `SENT` once
 * acknowledged (`docs/channel-adapters.md`: "No delivery read receipts... SENT is this
 * channel's terminal tracked status"), so a delivery-report round trip would add complexity
 * (and another BroadcastReceiver lifecycle to manage) with no server-side consumer for it.
 */
class SmsSendManager(private val context: Context) {

    sealed interface SendOutcome {
        data object Success : SendOutcome
        data class Failure(val reason: String) : SendOutcome
    }

    /**
     * @param subscriptionId a specific dual-SIM subscription id, or -1 to use the OS default
     *   SMS subscription (README's "Carrier limitations" — "Dual-SIM devices" section).
     */
    suspend fun send(to: String, text: String, subscriptionId: Int): SendOutcome {
        if (to.isBlank() || to.none { it.isDigit() }) {
            // README's mapped rule: "the destination number is obviously malformed (empty,
            // no digits)" -> INVALID_NUMBER, checked before ever touching SmsManager.
            return SendOutcome.Failure(AndroidFailureReason.INVALID_NUMBER)
        }

        val smsManager = try {
            resolveSmsManager(subscriptionId)
        } catch (e: SecurityException) {
            return SendOutcome.Failure(AndroidFailureReason.SIM_ERROR)
        } catch (e: IllegalArgumentException) {
            // Thrown by getSmsManagerForSubscriptionId when the configured SIM is no longer
            // present/active — README: "re-validate that the configured SIM is still
            // present/active at each send attempt (report SIM_ERROR if it was removed)."
            return SendOutcome.Failure(AndroidFailureReason.SIM_ERROR)
        }

        val parts = smsManager.divideMessage(text)
        if (parts.isEmpty()) {
            return SendOutcome.Failure(AndroidFailureReason.UNKNOWN)
        }

        val requestId = "${System.currentTimeMillis()}_${Random.nextInt(1_000_000)}"
        val resultCodes = IntArray(parts.size) { UNSET_RESULT_CODE }

        return try {
            suspendCancellableCoroutine { continuation ->
                var receivedCount = 0
                val actionForIndex = List(parts.size) { index -> "$SENT_ACTION_PREFIX.$requestId.$index" }

                val receiver = object : BroadcastReceiver() {
                    override fun onReceive(receiverContext: Context, intent: Intent) {
                        val action = intent.action ?: return
                        val index = actionForIndex.indexOf(action)
                        if (index < 0 || resultCodes[index] != UNSET_RESULT_CODE) return
                        resultCodes[index] = resultCode
                        receivedCount += 1
                        if (receivedCount == parts.size) {
                            try {
                                context.unregisterReceiver(this)
                            } catch (_: IllegalArgumentException) {
                                // Already unregistered (e.g. coroutine cancellation raced us) — fine.
                            }
                            if (continuation.isActive) {
                                continuation.resume(classify(resultCodes))
                            }
                        }
                    }
                }

                actionForIndex.forEach { action ->
                    ContextCompat.registerReceiver(
                        context,
                        receiver,
                        IntentFilter(action),
                        ContextCompat.RECEIVER_NOT_EXPORTED,
                    )
                }

                continuation.invokeOnCancellation {
                    try {
                        context.unregisterReceiver(receiver)
                    } catch (_: IllegalArgumentException) {
                        // Already unregistered.
                    }
                }

                val sentIntents = actionForIndex.map { action ->
                    PendingIntent.getBroadcast(
                        context,
                        Random.nextInt(),
                        Intent(action).setPackage(context.packageName),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    )
                }

                try {
                    smsManager.sendMultipartTextMessage(to, null, parts, ArrayList(sentIntents), null)
                } catch (e: SecurityException) {
                    try {
                        context.unregisterReceiver(receiver)
                    } catch (_: IllegalArgumentException) {
                    }
                    if (continuation.isActive) {
                        continuation.resume(SendOutcome.Failure(AndroidFailureReason.SIM_ERROR))
                    }
                } catch (e: IllegalArgumentException) {
                    try {
                        context.unregisterReceiver(receiver)
                    } catch (_: IllegalArgumentException) {
                    }
                    if (continuation.isActive) {
                        continuation.resume(SendOutcome.Failure(AndroidFailureReason.INVALID_NUMBER))
                    }
                }
            }
        } catch (e: SecurityException) {
            SendOutcome.Failure(AndroidFailureReason.SIM_ERROR)
        }
    }

    /**
     * `SmsManager.getDefault()`/`getSmsManagerForSubscriptionId(Int)` were superseded on API 31+
     * by a Context-obtained instance plus [SmsManager.createForSubscriptionId] — the modern
     * path is used whenever it's available; the deprecated static methods are the only option
     * on this app's minSdk 26-30 range, so they're kept (suppressed, not deleted) for that
     * range rather than raising minSdk just to silence a lint warning.
     */
    private fun resolveSmsManager(subscriptionId: Int): SmsManager {
        val default = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(SmsManager::class.java)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getDefault()
        }
        if (subscriptionId < 0) return default
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            default.createForSubscriptionId(subscriptionId)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
        }
    }

    /** Worst-of-N across every segment: any single failed segment fails the whole message. */
    private fun classify(resultCodes: IntArray): SendOutcome {
        val failureCode = resultCodes.firstOrNull { it != Activity.RESULT_OK }
        return if (failureCode == null) {
            SendOutcome.Success
        } else {
            SendOutcome.Failure(mapResultCodeToReason(failureCode))
        }
    }

    /**
     * Maps an Android `SmsManager` result code to the server's `AndroidFailureReason` enum,
     * per README's explicit table in "SMS send/receive workflow":
     *   RESULT_ERROR_NO_SERVICE / RESULT_ERROR_RADIO_OFF -> NO_SIGNAL
     *   any SIM-related SecurityException/absent-SIM -> SIM_ERROR (handled above, before this
     *     point is ever reached, since that's caught as an exception rather than a result code)
     *   anything else / unrecognized result code -> UNKNOWN
     * `RESULT_ERROR_GENERIC_FAILURE` for an obviously-malformed number is handled up front by
     * the pre-send blank/no-digits check above, not here — a `GENERIC_FAILURE` that reaches
     * this point (i.e. the number passed that basic check) falls through to `UNKNOWN`, per
     * the README's own "anything else" catch-all.
     */
    private fun mapResultCodeToReason(resultCode: Int): String =
        when (resultCode) {
            SmsManager.RESULT_ERROR_NO_SERVICE, SmsManager.RESULT_ERROR_RADIO_OFF -> AndroidFailureReason.NO_SIGNAL
            else -> AndroidFailureReason.UNKNOWN
        }

    companion object {
        private const val SENT_ACTION_PREFIX = "com.autotranslator.gateway.SMS_SENT"
        private const val UNSET_RESULT_CODE = Int.MIN_VALUE
    }
}
