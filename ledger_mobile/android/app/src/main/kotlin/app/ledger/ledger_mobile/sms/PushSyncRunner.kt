package app.ledger.ledger_mobile.sms

import android.content.Context
import android.util.Log
import java.io.BufferedReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/** Posts approved app alerts on the same WorkManager path as SMS, with channel "push". */
internal object PushSyncRunner {
    private const val TAG = "LedgerPush"

    fun upload(context: Context): UploadOutcome {
        val app = context.applicationContext
        val base = FlutterPrefs.getString(app, FlutterPrefs.SERVER_URL)?.trim().orEmpty()
        val token = FlutterPrefs.getString(app, FlutterPrefs.TOKEN)?.trim().orEmpty()
        val url = alertsUrl(base)
        val items = PushQueues.snapshot(app)
        if (items.isEmpty()) return UploadOutcome(0, 0, retry = false, queued = 0, error = null)
        if (url == null || token.isEmpty()) {
            return UploadOutcome(0, items.size, retry = false, queued = items.size, error = null)
        }
        val decision = try {
            flushUploads(items, channel = "push") { json -> postJson(url, token, json) }
        } catch (error: Exception) {
            Log.i(TAG, "upload failed: ${error.javaClass.simpleName}")
            return UploadOutcome(0, items.size, retry = true, queued = items.size, error = null)
        }
        PushQueues.remove(app, decision.removeIds)
        val unconfirmed = (items.size - decision.removeIds.size).coerceAtLeast(0)
        return UploadOutcome(
            sent = decision.sent,
            kept = unconfirmed,
            retry = decision.retry,
            queued = PushQueues.snapshot(app).size,
            error = null,
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
}
