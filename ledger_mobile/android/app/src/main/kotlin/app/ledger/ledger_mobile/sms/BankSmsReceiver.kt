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
        val prefs = context.getSharedPreferences("ledger_sms", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("opt_in", false)) return
        val extras = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val bySender = extras.groupBy { it.displayOriginatingAddress ?: "" }
        val queue = JSONArray(prefs.getString("queue", "[]"))
        for ((sender, parts) in bySender) {
            if (!BankSenders.isAllowed(sender)) continue
            val body = parts.joinToString("") { it.displayMessageBody ?: it.messageBody ?: "" }
            val item = JSONObject()
            item.put("sender", sender)
            item.put("body", body)
            item.put("receivedAt", System.currentTimeMillis())
            queue.put(item)
        }
        prefs.edit().putString("queue", queue.toString()).apply()
    }
}
