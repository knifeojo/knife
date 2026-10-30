package app.ledger.ledger_mobile.sms

import android.content.Context
import android.util.Log
import java.io.BufferedReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Posts the native queue to `POST /api/v1/alerts/sms`.
 * Items are deleted only after a 2xx that confirms every row. The server dedups on sourceId,
 * so a retry or an overlapping flush does not create a second transaction.
 */
internal object SmsSyncRunner {
    private const val TAG = "LedgerSms"

    fun upload(context: Context): UploadOutcome {
        val app = context.applicationContext
        if (!SmsQueues.isOptedIn(app)) return UploadOutcome(sent = 0, kept = 0, retry = false, queued = 0, error = null)
        val base = FlutterPrefs.getString(app, FlutterPrefs.SERVER_URL)?.trim().orEmpty()
        val token = FlutterPrefs.getString(app, FlutterPrefs.TOKEN)?.trim().orEmpty()
        val url = alertsUrl(base)
        val items = SmsQueues.snapshot(app)
        if (items.isEmpty()) return UploadOutcome(0, 0, retry = false, queued = 0, error = null)
        if (url == null || token.isEmpty()) {
            return UploadOutcome(0, items.size, retry = false, queued = items.size, error = null)
        }
        val decision = try {
            flushUploads(items) { json -> postJson(url, token, json) }
        } catch (error: Exception) {
            Log.i(TAG, "upload failed: ${error.javaClass.simpleName}")
            return UploadOutcome(0, items.size, retry = true, queued = items.size, error = OFFLINE)
        }
        SmsQueues.remove(app, decision.removeIds)
        SmsQueues.noteSent(app, decision.removeIds)
        val unconfirmed = (items.size - decision.removeIds.size).coerceAtLeast(0)
        val queued = SmsQueues.snapshot(app).size
        if (decision.sent > 0 || decision.retry) {
            Log.i(TAG, "sms upload sent=${decision.sent} kept=$unconfirmed retry=${decision.retry}")
        }
        return UploadOutcome(
            sent = decision.sent,
            kept = unconfirmed,
            retry = decision.retry,
            queued = queued,
            error = if (decision.retry) OFFLINE else null,
        )
    }

    private fun postJson(url: String, token: String, json: String): HttpReply {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 20_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Authorization", "Bearer $token")
        }
        try {
            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { it.write(json) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            return HttpReply(status, body)
        } finally {
            connection.disconnect()
        }
    }

    private const val OFFLINE = "Could not reach the Ledger server. Bank SMS stay on this phone until the next sync."
}

internal data class UploadOutcome(
    val sent: Int,
    val kept: Int,
    val retry: Boolean,
    val queued: Int,
    val error: String?,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "sent" to sent,
        "kept" to kept,
        "ok" to !retry && kept == 0,
        "queued" to queued,
        "error" to error,
    )
}
