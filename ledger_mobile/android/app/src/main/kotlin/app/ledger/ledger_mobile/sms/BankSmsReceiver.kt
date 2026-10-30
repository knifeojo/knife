package app.ledger.ledger_mobile.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject

/**
 * Incoming SMS, including while the Flutter activity is dead.
 * Personal numbers are dropped before the body is kept. Financial texts from a known or
 * approved sender are queued and an expedited WorkManager upload is scheduled. A new
 * financial sender is held until the app asks "Track texts from X?".
 */
class BankSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        if (!SmsQueues.isOptedIn(context)) return
        val extras = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val bySender = extras.groupBy { it.displayOriginatingAddress ?: "" }
        var schedule = false
        var notify = false
        for ((sender, parts) in bySender) {
            if (isPersonalSender(sender)) continue
            val body = parts.joinToString("") { it.displayMessageBody ?: it.messageBody ?: "" }
            val receivedAt = parts.map { it.timestampMillis }.filter { it > 0L }.maxOrNull()
                ?: System.currentTimeMillis()
            val incoming = SmsQueues.handleIncoming(context, sender, body, receivedAt)
            schedule = schedule || incoming.schedule
            notify = notify || incoming.notify
        }
        if (schedule) SmsSyncScheduler.enqueueUpload(context)
        if (schedule || notify) SmsCapture.queued()
    }

    companion object {
        const val PREFS = SmsQueues.PREFS
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
