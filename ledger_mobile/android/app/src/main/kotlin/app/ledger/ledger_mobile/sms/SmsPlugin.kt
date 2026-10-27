package app.ledger.ledger_mobile.sms

import android.Manifest
import android.content.pm.PackageManager
import android.provider.Telephony
import androidx.core.content.ContextCompat
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray

class SmsPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private lateinit var channel: MethodChannel
    private lateinit var app: android.content.Context

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        app = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, "ledger/sms")
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val prefs = app.getSharedPreferences("ledger_sms", android.content.Context.MODE_PRIVATE)
        when (call.method) {
            "setOptIn" -> {
                prefs.edit().putBoolean("opt_in", call.argument<Boolean>("value") == true).apply()
                result.success(true)
            }
            "pending" -> {
                val raw = prefs.getString("queue", "[]")
                result.success(raw)
            }
            "clearPending" -> {
                prefs.edit().putString("queue", "[]").apply()
                result.success(true)
            }
            "hasPermission" -> {
                val read = ContextCompat.checkSelfPermission(app, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED
                result.success(read)
            }
            "importInbox" -> {
                if (ContextCompat.checkSelfPermission(app, Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
                    result.error("denied", "SMS permission not granted", null)
                    return
                }
                val from = call.argument<Long>("fromMs") ?: 0L
                val to = call.argument<Long>("toMs") ?: System.currentTimeMillis()
                val out = JSONArray()
                val cursor = app.contentResolver.query(
                    Telephony.Sms.Inbox.CONTENT_URI,
                    arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
                    "${Telephony.Sms.DATE} >= ? AND ${Telephony.Sms.DATE} <= ?",
                    arrayOf(from.toString(), to.toString()),
                    "${Telephony.Sms.DATE} ASC",
                )
                cursor?.use {
                    val iAddr = it.getColumnIndex(Telephony.Sms.ADDRESS)
                    val iBody = it.getColumnIndex(Telephony.Sms.BODY)
                    val iDate = it.getColumnIndex(Telephony.Sms.DATE)
                    while (it.moveToNext()) {
                        val sender = it.getString(iAddr) ?: continue
                        if (!BankSenders.isAllowed(sender)) continue
                        val item = org.json.JSONObject()
                        item.put("sender", sender)
                        item.put("body", it.getString(iBody) ?: "")
                        item.put("receivedAt", it.getLong(iDate))
                        out.put(item)
                    }
                }
                result.success(out.toString())
            }
            else -> result.notImplemented()
        }
    }
}
