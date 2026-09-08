package com.autotranslator.gateway.data

import android.content.Context
import java.io.File
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * A small on-device queue for inbound SMS the app has received but not yet successfully
 * pushed to `POST /api/gateways/inbound` — per README's "Retry behavior" section: "if the
 * device fails to reach the server after all retries, queue the inbound SMS locally (a small
 * on-device DB/file, not just in memory) and retry on the next successful connectivity
 * check... an inbound SMS must never be silently dropped just because the network was
 * briefly down."
 *
 * Deliberately a flat JSON file rather than a full database (Room, SQLite) — a gateway
 * device's queue depth is expected to stay tiny (a handful of messages at most, given the
 * poll/heartbeat loop retries every cycle), so a single small file guarded by a coroutine
 * [Mutex] is enough without pulling in a persistence framework for a handful of rows. Every
 * queued entry carries the same `externalMessageId` the [android.telephony.TelephonyIntent]
 * receiver derived, so a redelivered entry is safe to resend — the server's dedup key
 * (`(deviceId, externalMessageId)`) makes retrying the same entry any number of times
 * idempotent (see `docs/channel-adapters.md`'s `/inbound` section).
 */
class PendingInboundStore(context: Context) {

    @Serializable
    data class Entry(
        val from: String,
        val text: String,
        val sentAt: String,
        val externalMessageId: String,
    )

    private val file = File(context.filesDir, "pending_inbound_sms.json")
    private val mutex = Mutex()
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun enqueue(entry: Entry) {
        mutex.withLock {
            val current = readLocked().toMutableList()
            // Dedup on-device too, so a receiver re-delivery (rare, but the README notes it's
            // possible on some OEMs) doesn't grow the queue with two identical entries.
            if (current.none { it.externalMessageId == entry.externalMessageId }) {
                current.add(entry)
                writeLocked(current)
            }
        }
    }

    suspend fun peekAll(): List<Entry> = mutex.withLock { readLocked() }

    suspend fun remove(externalMessageId: String) {
        mutex.withLock {
            val current = readLocked().filterNot { it.externalMessageId == externalMessageId }
            writeLocked(current)
        }
    }

    private fun readLocked(): List<Entry> {
        if (!file.exists()) return emptyList()
        return try {
            json.decodeFromString<List<Entry>>(file.readText())
        } catch (_: Exception) {
            // A corrupted queue file should never crash the service — worst case we lose the
            // locally-queued backlog, which is strictly better than a crash loop.
            emptyList()
        }
    }

    private fun writeLocked(entries: List<Entry>) {
        file.writeText(json.encodeToString(entries))
    }
}
