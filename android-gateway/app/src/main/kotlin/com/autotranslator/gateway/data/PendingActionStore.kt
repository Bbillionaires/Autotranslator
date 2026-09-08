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
 * Queues an `acknowledge`/`fail` call for a specific outbound message that could not reach
 * the server, so it is retried on a later poll cycle instead of being abandoned — per
 * README's "Retry behavior": "an acknowledge/fail call that fails to reach the server should
 * be retried (the server-side acknowledge handler is idempotent specifically so a retried ack
 * is always safe) rather than abandoned — an un-acknowledged QUEUED message would otherwise
 * appear to staff as 'still pending' indefinitely even though the SMS actually went out."
 *
 * Keyed by `messageId` alone (not messageId+type): a given `Message.id` only ever has one
 * real outcome (it was sent, or it wasn't), so at most one queued action can ever exist for
 * it — a second `enqueue` call for the same id replaces the first rather than accumulating.
 */
class PendingActionStore(context: Context) {

    @Serializable
    data class Entry(
        val type: Type,
        val messageId: String,
        val externalMessageId: String? = null,
        val reason: String? = null,
    ) {
        enum class Type { ACKNOWLEDGE, FAIL }
    }

    private val file = File(context.filesDir, "pending_actions.json")
    private val mutex = Mutex()
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun enqueue(entry: Entry) {
        mutex.withLock {
            val current = readLocked().filterNot { it.messageId == entry.messageId }.toMutableList()
            current.add(entry)
            writeLocked(current)
        }
    }

    suspend fun peekAll(): List<Entry> = mutex.withLock { readLocked() }

    suspend fun remove(messageId: String) {
        mutex.withLock {
            writeLocked(readLocked().filterNot { it.messageId == messageId })
        }
    }

    private fun readLocked(): List<Entry> {
        if (!file.exists()) return emptyList()
        return try {
            json.decodeFromString<List<Entry>>(file.readText())
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun writeLocked(entries: List<Entry>) {
        file.writeText(json.encodeToString(entries))
    }
}
