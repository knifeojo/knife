package app.ledger.ledger_mobile.sms

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * Native SMS queues in the `ledger_sms` preferences file.
 *
 * `queue` is safe to upload (known bank or a sender the user already approved).
 * `pending_by_sender` holds financial texts from a sender we have not asked about yet.
 * `sender_choice` is "yes" or "no" per sender key. An item leaves `queue` only after HTTP 2xx.
 */
internal object SmsQueues {
    const val PREFS = "ledger_sms"
    private const val OPT_IN = "opt_in"
    private const val QUEUE = "queue"
    private const val PENDING = "pending_by_sender"
    private const val CHOICES = "sender_choice"
    private const val COUNTED = "sent_ids"
    private const val PENDING_CAP = 20
    val lock = Any()

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isOptedIn(context: Context): Boolean = prefs(context).getBoolean(OPT_IN, false)

    fun senderKey(sender: String): String = sender.trim().lowercase()

    fun handleIncoming(context: Context, sender: String, body: String, receivedAt: Long): Incoming {
        val app = context.applicationContext
        var schedule = false
        var notify = false
        synchronized(lock) {
            if (!isOptedIn(app)) return Incoming(schedule = false, notify = false)
            when (
                senderAction(
                    sender,
                    body,
                    known = BankSenders.isKnown(sender),
                    approved = isApproved(app, sender),
                    denied = isDenied(app, sender),
                )
            ) {
                SenderAction.UPLOAD -> {
                    if (enqueue(app, sender, body, receivedAt, countCapture = true)) schedule = true
                }
                SenderAction.ASK -> {
                    if (rememberPending(app, sender, body, receivedAt)) notify = true
                }
                SenderAction.DROP -> Unit
            }
        }
        return Incoming(schedule, notify)
    }

    fun approve(context: Context, sender: String) {
        val app = context.applicationContext
        val key = senderKey(sender)
        if (key.isEmpty()) return
        synchronized(lock) {
            setChoice(app, key, "yes")
            val pending = readPending(app)
            val rows = pending.optJSONArray(key) ?: JSONArray()
            pending.remove(key)
            writePending(app, pending)
            for (i in 0 until rows.length()) {
                val obj = rows.optJSONObject(i) ?: continue
                enqueueObject(app, obj, countCapture = true)
            }
        }
    }

    fun deny(context: Context, sender: String) {
        val app = context.applicationContext
        val key = senderKey(sender)
        if (key.isEmpty()) return
        synchronized(lock) {
            setChoice(app, key, "no")
            val pending = readPending(app)
            pending.remove(key)
            writePending(app, pending)
        }
    }

    fun pendingSenderNames(context: Context): List<String> {
        synchronized(lock) {
            val pending = readPending(context.applicationContext)
            val names = mutableListOf<String>()
            val keys = pending.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val rows = pending.optJSONArray(key) ?: continue
                if (rows.length() == 0) continue
                val display = rows.optJSONObject(0)?.optString("sender")?.takeIf { it.isNotEmpty() } ?: key
                names.add(display)
            }
            return names
        }
    }

    fun approvedSenders(context: Context): List<String> = choices(context, "yes")

    fun deniedSenders(context: Context): List<String> = choices(context, "no")

    fun isApproved(context: Context, sender: String): Boolean =
        readChoices(context.applicationContext).optString(senderKey(sender)) == "yes"

    fun isDenied(context: Context, sender: String): Boolean =
        readChoices(context.applicationContext).optString(senderKey(sender)) == "no"

    fun snapshot(context: Context): List<UploadItem> {
        synchronized(lock) {
            drainOutbox(context.applicationContext)
            return readQueue(context.applicationContext).toUploadItems()
        }
    }

    fun remove(context: Context, ids: Set<String>) {
        if (ids.isEmpty()) return
        synchronized(lock) {
            val queue = readQueue(context.applicationContext)
            val next = JSONArray()
            for (i in 0 until queue.length()) {
                val obj = queue.optJSONObject(i) ?: continue
                if (queueItemId(obj) !in ids) next.put(obj)
            }
            prefs(context).edit().putString(QUEUE, next.toString()).commit()
        }
    }

    /** How many of [ids] had not been counted yet. Also bumps the Flutter sent counter and Last synced. */
    fun noteSent(context: Context, ids: Collection<String>): Int {
        if (ids.isEmpty()) return 0
        val app = context.applicationContext
        synchronized(lock) {
            val seen = readCounted(app)
            val fresh = ids.filter { it.isNotEmpty() && seen.add(it) }
            if (fresh.isEmpty()) return 0
            writeCounted(app, seen)
            FlutterPrefs.bump(app, FlutterPrefs.SENT, fresh.size)
            FlutterPrefs.putString(app, FlutterPrefs.LAST_SYNC, receivedAtIso(System.currentTimeMillis()))
            return fresh.size
        }
    }

    fun importInbox(context: Context, fromMs: Long, toMs: Long, sender: String? = null): JSONArray {
        val app = context.applicationContext
        val out = JSONArray()
        val cursor = app.contentResolver.query(
            android.provider.Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(
                android.provider.Telephony.Sms.ADDRESS,
                android.provider.Telephony.Sms.BODY,
                android.provider.Telephony.Sms.DATE,
            ),
            "${android.provider.Telephony.Sms.DATE} >= ? AND ${android.provider.Telephony.Sms.DATE} <= ?",
            arrayOf(fromMs.toString(), toMs.toString()),
            "${android.provider.Telephony.Sms.DATE} ASC",
        )
        cursor?.use {
            val iAddr = it.getColumnIndex(android.provider.Telephony.Sms.ADDRESS)
            val iBody = it.getColumnIndex(android.provider.Telephony.Sms.BODY)
            val iDate = it.getColumnIndex(android.provider.Telephony.Sms.DATE)
            while (it.moveToNext()) {
                val address = it.getString(iAddr) ?: continue
                if (isPersonalSender(address)) continue
                if (sender != null && !address.equals(sender, ignoreCase = true)) continue
                val senderName = address
                val body = it.getString(iBody) ?: ""
                val receivedAt = it.getLong(iDate)
                val added = synchronized(lock) {
                    when (
                        senderAction(
                            senderName,
                            body,
                            known = BankSenders.isKnown(senderName),
                            approved = isApproved(app, senderName),
                            denied = isDenied(app, senderName),
                        )
                    ) {
                        SenderAction.UPLOAD -> enqueue(app, senderName, body, receivedAt, countCapture = true)
                        SenderAction.ASK -> rememberPending(app, senderName, body, receivedAt)
                        SenderAction.DROP -> false
                    }
                }
                if (added && senderAction(senderName, body, approved = isApproved(app, senderName)) == SenderAction.UPLOAD) {
                    val item = JSONObject()
                    item.put("id", smsSourceId(senderName, body, receivedAt))
                    item.put("sender", senderName)
                    item.put("body", body)
                    item.put("receivedAt", receivedAt)
                    out.put(item)
                }
            }
        }
        return out
    }

    private fun choices(context: Context, value: String): List<String> {
        synchronized(lock) {
            val obj = readChoices(context.applicationContext)
            val keys = obj.keys()
            val out = mutableListOf<String>()
            while (keys.hasNext()) {
                val key = keys.next()
                if (obj.optString(key) == value) out.add(key)
            }
            return out
        }
    }

    private fun enqueue(context: Context, sender: String, body: String, receivedAt: Long, countCapture: Boolean): Boolean {
        val item = JSONObject()
        item.put("id", smsSourceId(sender, body, receivedAt))
        item.put("sender", sender)
        item.put("body", body)
        item.put("receivedAt", receivedAt)
        return enqueueObject(context, item, countCapture)
    }

    private fun enqueueObject(context: Context, item: JSONObject, countCapture: Boolean): Boolean {
        val queue = readQueue(context)
        val id = queueItemId(item)
        if (id.isEmpty() || existingIds(queue).contains(id)) return false
        if (!item.has("id")) item.put("id", id)
        queue.put(item)
        prefs(context).edit().putString(QUEUE, queue.toString()).commit()
        if (countCapture) FlutterPrefs.bump(context, FlutterPrefs.CAPTURED, 1)
        return true
    }

    private fun rememberPending(context: Context, sender: String, body: String, receivedAt: Long): Boolean {
        val key = senderKey(sender)
        val id = smsSourceId(sender, body, receivedAt)
        val pending = readPending(context)
        val rows = pending.optJSONArray(key) ?: JSONArray()
        for (i in 0 until rows.length()) {
            val obj = rows.optJSONObject(i) ?: continue
            if (queueItemId(obj) == id) return false
        }
        while (rows.length() >= PENDING_CAP) rows.remove(0)
        val item = JSONObject()
        item.put("id", id)
        item.put("sender", sender)
        item.put("body", body)
        item.put("receivedAt", receivedAt)
        rows.put(item)
        pending.put(key, rows)
        writePending(context, pending)
        return true
    }

    private fun drainOutbox(context: Context) {
        val raw = FlutterPrefs.getString(context, FlutterPrefs.OUTBOX) ?: return
        if (raw.isBlank() || raw == "[]") return
        val arr = try {
            JSONArray(raw)
        } catch (_: Exception) {
            return
        }
        var moved = false
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val sender = obj.optString("sender")
            val body = obj.optString("body")
            val id = obj.optString("sourceId").ifEmpty { obj.optString("id") }
            if (sender.isEmpty() || body.isEmpty() || id.isEmpty()) continue
            if (senderAction(sender, body, approved = isApproved(context, sender), denied = isDenied(context, sender)) != SenderAction.UPLOAD) {
                continue
            }
            val receivedAt = parseReceivedAt(obj.opt("receivedAt"))
            val item = JSONObject()
            item.put("id", id)
            item.put("sender", sender)
            item.put("body", body)
            item.put("receivedAt", receivedAt)
            if (enqueueObject(context, item, countCapture = false)) moved = true
        }
        if (moved || arr.length() > 0) FlutterPrefs.putString(context, FlutterPrefs.OUTBOX, "[]")
    }

    private fun parseReceivedAt(value: Any?): Long {
        return when (value) {
            is Number -> value.toLong()
            is String -> try {
                Instant.parse(value).toEpochMilli()
            } catch (_: Exception) {
                System.currentTimeMillis()
            }
            else -> System.currentTimeMillis()
        }
    }

    private fun readQueue(context: Context): JSONArray =
        try {
            JSONArray(prefs(context).getString(QUEUE, "[]"))
        } catch (_: Exception) {
            JSONArray()
        }

    private fun readPending(context: Context): JSONObject =
        try {
            JSONObject(prefs(context).getString(PENDING, "{}"))
        } catch (_: Exception) {
            JSONObject()
        }

    private fun writePending(context: Context, pending: JSONObject) {
        prefs(context).edit().putString(PENDING, pending.toString()).commit()
    }

    private fun readChoices(context: Context): JSONObject =
        try {
            JSONObject(prefs(context).getString(CHOICES, "{}"))
        } catch (_: Exception) {
            JSONObject()
        }

    private fun setChoice(context: Context, key: String, value: String) {
        val choices = readChoices(context)
        choices.put(key, value)
        prefs(context).edit().putString(CHOICES, choices.toString()).commit()
    }

    private fun readCounted(context: Context): MutableSet<String> {
        val raw = prefs(context).getString(COUNTED, "[]") ?: "[]"
        val out = linkedSetOf<String>()
        try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val id = arr.optString(i)
                if (id.isNotEmpty()) out.add(id)
            }
        } catch (_: Exception) {
            return out
        }
        return out
    }

    private fun writeCounted(context: Context, ids: Set<String>) {
        val list = ids.toList()
        val trimmed = if (list.size > 4000) list.takeLast(4000) else list
        val arr = JSONArray()
        trimmed.forEach { arr.put(it) }
        prefs(context).edit().putString(COUNTED, arr.toString()).commit()
    }
}

internal data class Incoming(val schedule: Boolean, val notify: Boolean)

private fun JSONArray.toUploadItems(): List<UploadItem> {
    val out = mutableListOf<UploadItem>()
    for (i in 0 until length()) {
        val obj = optJSONObject(i) ?: continue
        val id = queueItemId(obj)
        if (id.isEmpty()) continue
        out.add(
            UploadItem(
                id = id,
                sender = obj.optString("sender"),
                body = obj.optString("body"),
                receivedAtMillis = obj.optLong("receivedAt"),
            ),
        )
    }
    return out
}
