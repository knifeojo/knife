package app.ledger.ledger_mobile.sms

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * Queue and upload decisions with no Android APIs, so unit tests can run on a JVM.
 *
 * The server dedups `POST /api/v1/alerts/sms` on `sourceId` (same id → duplicate, review, or
 * skipped — never a second transaction). Callers remove an item only when this returns it in
 * [FlushDecision.removeIds], which requires an HTTP 2xx and one status string per message.
 * A network error, 4xx, or 5xx removes nothing. 5xx and transport failures set [FlushDecision.retry]
 * so WorkManager can apply exponential backoff.
 */
data class UploadItem(
    val id: String,
    val sender: String,
    val body: String,
    val receivedAtMillis: Long,
)

class UploadQueue {
    private val items = linkedMapOf<String, UploadItem>()

    fun add(item: UploadItem): Boolean {
        if (item.id.isEmpty() || items.containsKey(item.id)) return false
        items[item.id] = item
        return true
    }

    fun list(): List<UploadItem> = items.values.toList()

    fun remove(ids: Set<String>) {
        ids.forEach { items.remove(it) }
    }
}

data class HttpReply(val status: Int, val body: String)

fun interface SmsPoster {
    fun post(json: String): HttpReply
}

data class FlushDecision(
    val removeIds: Set<String>,
    val retry: Boolean,
    val sent: Int,
)

private val isoUtc: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

fun receivedAtIso(millis: Long): String = isoUtc.format(Instant.ofEpochMilli(millis))

fun jsonString(value: String): String {
    val sb = StringBuilder(value.length + 2)
    sb.append('"')
    for (ch in value) {
        when (ch) {
            '\\' -> sb.append("\\\\")
            '"' -> sb.append("\\\"")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> if (ch.code < 0x20) sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
        }
    }
    sb.append('"')
    return sb.toString()
}

fun payloadJson(items: List<UploadItem>, channel: String? = null): String {
    val sb = StringBuilder()
    sb.append("{\"messages\":[")
    items.forEachIndexed { index, item ->
        if (index > 0) sb.append(',')
        sb.append("{\"sender\":")
        sb.append(jsonString(item.sender))
        sb.append(",\"body\":")
        sb.append(jsonString(item.body))
        sb.append(",\"receivedAt\":")
        sb.append(jsonString(receivedAtIso(item.receivedAtMillis)))
        sb.append(",\"sourceId\":")
        sb.append(jsonString(item.id))
        if (!channel.isNullOrEmpty()) {
            sb.append(",\"channel\":")
            sb.append(jsonString(channel))
        }
        sb.append('}')
    }
    sb.append("]}")
    return sb.toString()
}

fun chunkUploads(items: List<UploadItem>, maxBytes: Int = 16000): List<List<UploadItem>> {
    val chunks = mutableListOf<List<UploadItem>>()
    var current = mutableListOf<UploadItem>()
    for (item in items) {
        if (current.isEmpty()) {
            current.add(item)
            continue
        }
        val next = current + item
        if (payloadJson(next).toByteArray(Charsets.UTF_8).size > maxBytes) {
            chunks.add(current.toList())
            current = mutableListOf(item)
        } else {
            current.add(item)
        }
    }
    if (current.isNotEmpty()) chunks.add(current.toList())
    return chunks
}

private val resultsArray = Regex(""""results"\s*:\s*\[(.*)]""", RegexOption.DOT_MATCHES_ALL)
private val statusField = Regex(""""status"\s*:\s*"([^"]+)"""")

/** Status strings inside `results`, or null when the body is not a per-message confirmation. */
fun statusesFromResults(body: String): List<String>? {
    val inner = resultsArray.find(body)?.groupValues?.get(1) ?: return null
    return statusField.findAll(inner).map { it.groupValues[1] }.toList()
}

/**
 * Posts [items]. Ids in [FlushDecision.removeIds] are safe to delete.
 * Anything else stays queued.
 */
fun flushUploads(items: List<UploadItem>, maxBytes: Int = 16000, channel: String? = null, poster: SmsPoster): FlushDecision {
    if (items.isEmpty()) return FlushDecision(emptySet(), retry = false, sent = 0)
    val remove = linkedSetOf<String>()
    var retry = false
    val chunks = chunkUploads(items, maxBytes)
    for (chunk in chunks) {
        val step = postChunk(chunk, channel, poster)
        remove.addAll(step.removeIds)
        if (step.retry) {
            retry = true
            break
        }
    }
    return FlushDecision(remove, retry, remove.size)
}

private data class Step(val removeIds: Set<String>, val retry: Boolean)

private fun postChunk(chunk: List<UploadItem>, channel: String?, poster: SmsPoster): Step {
    val reply = try {
        poster.post(payloadJson(chunk, channel))
    } catch (_: Exception) {
        return Step(emptySet(), retry = true)
    }
    if (reply.status == 400 && chunk.size > 1) {
        val remove = linkedSetOf<String>()
        for (item in chunk) {
            val one = postChunk(listOf(item), channel, poster)
            remove.addAll(one.removeIds)
            if (one.retry) return Step(remove, retry = true)
        }
        return Step(remove, retry = false)
    }
    if (reply.status !in 200..299) {
        val retry = reply.status == 429 || reply.status >= 500 || reply.status == 0
        return Step(emptySet(), retry)
    }
    val statuses = statusesFromResults(reply.body)
    if (statuses == null || statuses.size != chunk.size || statuses.any { it.isEmpty() }) {
        return Step(emptySet(), retry = true)
    }
    return Step(chunk.map { it.id }.toSet(), retry = false)
}

fun alertsUrl(base: String): String? {
    val trimmed = base.trim().trimEnd('/')
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null
    return "$trimmed/api/v1/alerts/sms"
}
