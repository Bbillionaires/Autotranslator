package com.autotranslator.gateway.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import androidx.core.content.ContextCompat
import com.autotranslator.gateway.data.GatewayConfigStore
import com.autotranslator.gateway.data.PendingInboundStore
import com.autotranslator.gateway.service.GatewayForegroundService
import java.security.MessageDigest
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Manifest-declared receiver for `android.provider.Telephony.SMS_RECEIVED`, per README's
 * "SMS send/receive workflow" → "Receiving": extracts sender + body + timestamp via
 * `Telephony.Sms.Intents.getMessagesFromIntent` (which reassembles multi-part inbound SMS for
 * us), derives a stable `externalMessageId`, persists the message to [PendingInboundStore]
 * (a `BroadcastReceiver.onReceive` has only a few seconds to run — file I/O here must go
 * through `goAsync()`, never the service's own coroutine scope directly), and kicks the
 * foreground service to flush it immediately. The service's own regular poll-loop flush is
 * what guarantees eventual delivery even if this immediate kick fails or the process dies
 * mid-flush.
 */
class SmsReceivedReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val configStore = GatewayConfigStore(context.applicationContext)
        if (!configStore.hasCredentials || configStore.revoked) {
            // Not configured (or revoked) — nothing to relay to; drop rather than queue
            // messages the app has no server to deliver them to.
            return
        }

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return

        // Multi-part inbound SMS share one originating address; concatenate their bodies in
        // arrival order into a single logical message, matching how a human reading their
        // own phone's Messages app would see it.
        val sender = messages.first().originatingAddress ?: return
        val body = messages.joinToString(separator = "") { it.messageBody ?: "" }
        val timestampMillis = messages.first().timestampMillis

        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val externalMessageId = deriveExternalMessageId(sender, timestampMillis)
                val store = PendingInboundStore(context.applicationContext)
                store.enqueue(
                    PendingInboundStore.Entry(
                        from = sender,
                        text = body,
                        sentAt = Instant.ofEpochMilli(timestampMillis).toString(),
                        externalMessageId = externalMessageId,
                    ),
                )
                ContextCompat.startForegroundService(
                    context.applicationContext,
                    Intent(context.applicationContext, GatewayForegroundService::class.java)
                        .setAction(GatewayForegroundService.ACTION_FLUSH_INBOUND),
                )
            } finally {
                pendingResult.finish()
            }
        }
    }

    /**
     * README: "Derive a stable externalMessageId for the server's dedup key — e.g.
     * sha256(senderAddress + ':' + timestampMillis) — so a redelivered broadcast (rare, but
     * possible on some OEMs) doesn't create a duplicate inbound message server-side."
     */
    private fun deriveExternalMessageId(sender: String, timestampMillis: Long): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$sender:$timestampMillis".toByteArray(Charsets.UTF_8))
        return digest.joinToString(separator = "") { "%02x".format(it) }
    }
}
