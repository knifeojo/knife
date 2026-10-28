package app.ledger.ledger_mobile.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject

/** Incoming SMS. Personal senders are dropped here and never handed to Flutter or uploaded. */
class BankSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean("opt_in", false)) return
        val extras = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val bySender = extras.groupBy { it.displayOriginatingAddress ?: "" }
        val queue = JSONArray(prefs.getString("queue", "[]"))
        val seen = existingIds(queue)
        var added = 0
        for ((sender, parts) in bySender) {
            if (!BankSenders.isAllowed(sender)) continue
            val body = parts.joinToString("") { it.displayMessageBody ?: it.messageBody ?: "" }
            val receivedAt = parts.map { it.timestampMillis }.filter { it > 0L }.maxOrNull() ?: System.currentTimeMillis()
            val id = smsSourceId(sender, body, receivedAt)
            if (!seen.add(id)) continue
            val item = JSONObject()
            item.put("id", id)
            item.put("sender", sender)
            item.put("body", body)
            item.put("receivedAt", receivedAt)
            queue.put(item)
            added += 1
        }
        if (added == 0) return
        prefs.edit().putString("queue", queue.toString()).apply()
        SmsCapture.queued()
    }

    companion object {
        const val PREFS = "ledger_sms"
    }
}

internal fun existingIds(queue: JSONArray): MutableSet<String> {
    val ids = mutableSetOf<String>()
    for (i in 0 until queue.length()) {
        val obj = queue.optJSONObject(i) ?: continue
        ids.add(queueItemId(obj))
    }
    return ids
}

internal fun queueItemId(obj: JSONObject): String {
    val given = obj.optString("id")
    if (given.isNotEmpty()) return given
    return smsSourceId(obj.optString("sender"), obj.optString("body"), obj.optLong("receivedAt"))
}
