package app.ledger.ledger_mobile.sms

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Queue of approved app notifications waiting for the same WorkManager upload as SMS.
 * `pending_by_app` holds financial alerts until the user answers "Track alerts from App?".
 */
internal object PushQueues {
    const val PREFS = "ledger_push"
    private const val QUEUE = "queue"
    private const val PENDING = "pending_by_app"
    private const val CHOICES = "app_choice"
    private const val PENDING_CAP = 20
    private val lock = Any()

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun packageKey(packageName: String): String = packageName.trim().lowercase()

    fun isApproved(context: Context, packageName: String): Boolean =
        readChoices(context).optString(packageKey(packageName)) == "yes"

    fun isDenied(context: Context, packageName: String): Boolean =
        readChoices(context).optString(packageKey(packageName)) == "no"

    fun handlePosted(
        context: Context,
        packageName: String,
        appLabel: String,
        text: String,
        postTimeMillis: Long,
    ): PushDecision {
        val app = context.applicationContext
        val decision = decidePush(packageName, text, isApproved(app, packageName), isDenied(app, packageName))
        synchronized(lock) {
            when (decision) {
                PushDecision.UPLOAD -> enqueue(app, packageName, appLabel, text, postTimeMillis)
                PushDecision.ASK -> rememberPending(app, packageName, appLabel, text, postTimeMillis)
                PushDecision.DROP -> Unit
            }
        }
        return decision
    }

    fun approve(context: Context, packageName: String) {
        val app = context.applicationContext
        val key = packageKey(packageName)
        if (key.isEmpty()) return
        synchronized(lock) {
            setChoice(app, key, "yes")
            val pending = readPending(app)
            val rows = pending.optJSONArray(key) ?: JSONArray()
            pending.remove(key)
            writePending(app, pending)
            for (i in 0 until rows.length()) {
                val obj = rows.optJSONObject(i) ?: continue
                enqueueObject(app, obj)
            }
        }
    }

    fun deny(context: Context, packageName: String) {
        val app = context.applicationContext
        val key = packageKey(packageName)
        if (key.isEmpty()) return
        synchronized(lock) {
            setChoice(app, key, "no")
            val pending = readPending(app)
            pending.remove(key)
            writePending(app, pending)
        }
    }

    fun pendingApps(context: Context): List<Pair<String, String>> {
        synchronized(lock) {
            val pending = readPending(context.applicationContext)
            val out = mutableListOf<Pair<String, String>>()
            val keys = pending.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val rows = pending.optJSONArray(key) ?: continue
                if (rows.length() == 0) continue
                val label = rows.optJSONObject(0)?.optString("label")?.takeIf { it.isNotEmpty() } ?: key
                out.add(key to label)
            }
            return out
        }
    }

    fun snapshot(context: Context): List<UploadItem> {
        synchronized(lock) {
            val queue = readQueue(context.applicationContext)
            val items = mutableListOf<UploadItem>()
            for (i in 0 until queue.length()) {
                val obj = queue.optJSONObject(i) ?: continue
                val id = obj.optString("id")
                val sender = obj.optString("sender")
                val body = obj.optString("body")
                if (id.isEmpty() || sender.isEmpty() || body.isEmpty()) continue
                items.add(UploadItem(id, sender, body, obj.optLong("receivedAt")))
            }
            return items
        }
    }

    fun remove(context: Context, ids: Set<String>) {
        if (ids.isEmpty()) return
        synchronized(lock) {
            val queue = readQueue(context.applicationContext)
            val kept = JSONArray()
            for (i in 0 until queue.length()) {
                val obj = queue.optJSONObject(i) ?: continue
                if (obj.optString("id") !in ids) kept.put(obj)
            }
            prefs(context.applicationContext).edit().putString(QUEUE, kept.toString()).commit()
        }
    }

    private fun enqueue(context: Context, packageName: String, appLabel: String, text: String, postTimeMillis: Long): Boolean {
        val item = JSONObject()
        item.put("id", pushSourceId(packageName, postTimeMillis, text))
        item.put("sender", appLabel.ifBlank { packageName }.take(80))
        item.put("package", packageName)
        item.put("body", text.take(4000))
        item.put("receivedAt", postTimeMillis)
        return enqueueObject(context, item)
    }

    private fun enqueueObject(context: Context, item: JSONObject): Boolean {
        val queue = readQueue(context)
        val id = item.optString("id")
        if (id.isEmpty()) return false
        for (i in 0 until queue.length()) {
            if (queue.optJSONObject(i)?.optString("id") == id) return false
        }
        queue.put(item)
        prefs(context).edit().putString(QUEUE, queue.toString()).commit()
        return true
    }

    private fun rememberPending(context: Context, packageName: String, appLabel: String, text: String, postTimeMillis: Long): Boolean {
        val key = packageKey(packageName)
        val id = pushSourceId(packageName, postTimeMillis, text)
        val pending = readPending(context)
        val rows = pending.optJSONArray(key) ?: JSONArray()
        for (i in 0 until rows.length()) {
            if (rows.optJSONObject(i)?.optString("id") == id) return false
        }
        while (rows.length() >= PENDING_CAP) rows.remove(0)
        val item = JSONObject()
        item.put("id", id)
        item.put("label", appLabel.ifBlank { packageName })
        item.put("sender", appLabel.ifBlank { packageName }.take(80))
        item.put("package", packageName)
        item.put("body", text.take(4000))
        item.put("receivedAt", postTimeMillis)
        rows.put(item)
        pending.put(key, rows)
        writePending(context, pending)
        return true
    }

    private fun setChoice(context: Context, key: String, value: String) {
        val choices = readChoices(context)
        choices.put(key, value)
        prefs(context).edit().putString(CHOICES, choices.toString()).commit()
    }

    private fun readQueue(context: Context): JSONArray = readArray(context, QUEUE)

    private fun readArray(context: Context, key: String): JSONArray {
        val raw = prefs(context).getString(key, null) ?: return JSONArray()
        return try {
            JSONArray(raw)
        } catch (_: Exception) {
            JSONArray()
        }
    }

    private fun readPending(context: Context): JSONObject = readObject(context, PENDING)

    private fun readChoices(context: Context): JSONObject = readObject(context, CHOICES)

    private fun readObject(context: Context, key: String): JSONObject {
        val raw = prefs(context).getString(key, null) ?: return JSONObject()
        return try {
            JSONObject(raw)
        } catch (_: Exception) {
            JSONObject()
        }
    }

    private fun writePending(context: Context, pending: JSONObject) {
        prefs(context).edit().putString(PENDING, pending.toString()).commit()
    }
}
