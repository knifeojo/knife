package app.ledger.ledger_mobile.sms

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.provider.Telephony
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import org.json.JSONArray
import org.json.JSONObject

class SmsPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware, PluginRegistry.RequestPermissionsResultListener {
    private var channel: MethodChannel? = null
    private var app: Context? = null
    private var activity: Activity? = null
    private var activityBinding: ActivityPluginBinding? = null
    private var pending: MethodChannel.Result? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        app = binding.applicationContext
        val messenger = MethodChannel(binding.binaryMessenger, "ledger/sms")
        channel = messenger
        messenger.setMethodCallHandler(this)
        SmsCapture.onQueued = {
            channel?.invokeMethod("onCaptured", null)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        SmsCapture.onQueued = null
        channel?.setMethodCallHandler(null)
        channel = null
        complete("denied")
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
        activityBinding = binding
        binding.addRequestPermissionsResultListener(this)
    }

    override fun onDetachedFromActivityForConfigChanges() {
        activityBinding?.removeRequestPermissionsResultListener(this)
        activityBinding = null
        activity = null
        complete("denied")
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        onAttachedToActivity(binding)
    }

    override fun onDetachedFromActivity() {
        onDetachedFromActivityForConfigChanges()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray): Boolean {
        if (requestCode != REQUEST_SMS) return false
        val status = currentPermission()
        val context = app
        if (context != null && !hasSmsPermissions(context)) {
            context.getSharedPreferences(BankSmsReceiver.PREFS, Context.MODE_PRIVATE).edit().putBoolean(DENIED_ONCE, true).apply()
        }
        complete(status)
        return true
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val context = app
        if (context == null) {
            result.error("no_context", "SMS plugin is not attached", null)
            return
        }
        val prefs = context.getSharedPreferences(BankSmsReceiver.PREFS, Context.MODE_PRIVATE)
        when (call.method) {
            "setOptIn" -> {
                prefs.edit().putBoolean("opt_in", call.argument<Boolean>("value") == true).apply()
                result.success(true)
            }
            "isOptedIn" -> result.success(prefs.getBoolean("opt_in", false))
            "pending" -> result.success(normalizeQueue(prefs.getString("queue", "[]")).toString())
            "clearPending" -> {
                prefs.edit().putString("queue", "[]").apply()
                result.success(true)
            }
            "ack" -> {
                val drop = stringList(call.argument<List<*>>("ids"))
                val queue = JSONArray(prefs.getString("queue", "[]"))
                val next = JSONArray()
                for (i in 0 until queue.length()) {
                    val obj = queue.optJSONObject(i) ?: continue
                    if (queueItemId(obj) !in drop) next.put(obj)
                }
                prefs.edit().putString("queue", next.toString()).apply()
                result.success(true)
            }
            "hasPermission" -> result.success(hasSmsPermissions(context))
            "permissionStatus" -> result.success(currentPermission())
            "requestPermissions" -> requestPermissions(prefs, result)
            "openSettings" -> {
                openAppSettings(context)
                result.success(true)
            }
            "importInbox" -> importInbox(context, call, result)
            else -> result.notImplemented()
        }
    }

    private fun requestPermissions(prefs: android.content.SharedPreferences, result: MethodChannel.Result) {
        val context = app
        val host = activity
        if (context == null || host == null) {
            result.success("unavailable")
            return
        }
        if (hasSmsPermissions(context)) {
            result.success("granted")
            return
        }
        complete("denied")
        pending = result
        prefs.edit().putBoolean(ASKED, true).apply()
        ActivityCompat.requestPermissions(
            host,
            arrayOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS),
            REQUEST_SMS,
        )
    }

    private fun importInbox(context: Context, call: MethodCall, result: MethodChannel.Result) {
        if (!hasSmsPermissions(context)) {
            result.error("denied", "SMS permission not granted", null)
            return
        }
        val from = asLong(call.argument<Any>("fromMs")) ?: 0L
        val to = asLong(call.argument<Any>("toMs")) ?: System.currentTimeMillis()
        val allowed = BankSenders.allowed.toTypedArray()
        val marks = allowed.joinToString(",") { "?" }
        val selection = "${Telephony.Sms.DATE} >= ? AND ${Telephony.Sms.DATE} <= ? AND trim(lower(${Telephony.Sms.ADDRESS})) IN ($marks)"
        val args = arrayOf(from.toString(), to.toString(), *allowed)
        val out = JSONArray()
        val cursor = context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
            selection,
            args,
            "${Telephony.Sms.DATE} ASC",
        )
        cursor?.use {
            val iAddr = it.getColumnIndex(Telephony.Sms.ADDRESS)
            val iBody = it.getColumnIndex(Telephony.Sms.BODY)
            val iDate = it.getColumnIndex(Telephony.Sms.DATE)
            while (it.moveToNext()) {
                val sender = it.getString(iAddr) ?: continue
                if (!BankSenders.isAllowed(sender)) continue
                val body = it.getString(iBody) ?: ""
                val receivedAt = it.getLong(iDate)
                val item = JSONObject()
                item.put("id", smsSourceId(sender, body, receivedAt))
                item.put("sender", sender)
                item.put("body", body)
                item.put("receivedAt", receivedAt)
                out.put(item)
            }
        }
        result.success(out.toString())
    }

    private fun currentPermission(): String {
        val context = app ?: return "unavailable"
        if (hasSmsPermissions(context)) return "granted"
        val host = activity ?: return "denied"
        val prefs = context.getSharedPreferences(BankSmsReceiver.PREFS, Context.MODE_PRIVATE)
        val asked = prefs.getBoolean(ASKED, false)
        if (!asked) return "denied"
        val show = ActivityCompat.shouldShowRequestPermissionRationale(host, Manifest.permission.READ_SMS) ||
            ActivityCompat.shouldShowRequestPermissionRationale(host, Manifest.permission.RECEIVE_SMS)
        if (show) return "denied"
        return if (prefs.getBoolean(DENIED_ONCE, false)) "permanently_denied" else "denied"
    }

    private fun openAppSettings(context: Context) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", context.packageName, null)
        }
        val host = activity
        if (host != null) {
            host.startActivity(intent)
        } else {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
    }

    private fun complete(status: String) {
        val result = pending ?: return
        pending = null
        result.success(status)
    }

    private fun normalizeQueue(raw: String?): JSONArray {
        val queue = JSONArray(raw ?: "[]")
        val out = JSONArray()
        for (i in 0 until queue.length()) {
            val obj = queue.optJSONObject(i) ?: continue
            if (obj.optString("id").isEmpty()) obj.put("id", queueItemId(obj))
            out.put(obj)
        }
        return out
    }

    companion object {
        private const val REQUEST_SMS = 48141
        private const val ASKED = "permission_asked"
        private const val DENIED_ONCE = "permission_denied_once"

        private fun hasSmsPermissions(context: Context): Boolean {
            return granted(context, Manifest.permission.READ_SMS) && granted(context, Manifest.permission.RECEIVE_SMS)
        }

        private fun granted(context: Context, permission: String): Boolean {
            return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
        }

        private fun stringList(raw: List<*>?): Set<String> {
            if (raw == null) return emptySet()
            return raw.mapNotNull { it as? String }.toSet()
        }

        private fun asLong(value: Any?): Long? = when (value) {
            is Int -> value.toLong()
            is Long -> value
            is Number -> value.toLong()
            else -> null
        }
    }
}
