package app.ledger.ledger_mobile.sms

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
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
        if (contextOptedIn(binding.applicationContext)) {
            SmsSyncScheduler.ensurePeriodic(binding.applicationContext)
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
            context.getSharedPreferences(SmsQueues.PREFS, Context.MODE_PRIVATE).edit().putBoolean(DENIED_ONCE, true).apply()
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
        val prefs = context.getSharedPreferences(SmsQueues.PREFS, Context.MODE_PRIVATE)
        when (call.method) {
            "setOptIn" -> {
                val on = call.argument<Boolean>("value") == true
                prefs.edit().putBoolean("opt_in", on).apply()
                if (on) SmsSyncScheduler.ensurePeriodic(context) else SmsSyncScheduler.cancel(context)
                result.success(true)
            }
            "isOptedIn" -> result.success(prefs.getBoolean("opt_in", false))
            "ensureBackgroundSync" -> {
                if (prefs.getBoolean("opt_in", false)) SmsSyncScheduler.ensurePeriodic(context)
                result.success(true)
            }
            "uploadNow" -> {
                val reply = result
                Thread {
                    val outcome = try {
                        SmsSyncRunner.upload(context)
                    } catch (_: Exception) {
                        UploadOutcome(0, 0, retry = true, queued = 0, error = "Could not reach the Ledger server. Bank SMS stay on this phone until the next sync.")
                    }
                    Handler(Looper.getMainLooper()).post {
                        try {
                            reply.success(outcome.toMap())
                        } catch (_: Exception) {
                            // The engine was detached before the upload finished.
                        }
                    }
                }.start()
            }
            "pendingSenders" -> result.success(SmsQueues.pendingSenderNames(context))
            "approvedSenders" -> result.success(SmsQueues.approvedSenders(context))
            "deniedSenders" -> result.success(SmsQueues.deniedSenders(context))
            "approveSender" -> {
                SmsQueues.approve(context, call.argument<String>("sender") ?: "")
                SmsSyncScheduler.enqueueUpload(context)
                result.success(true)
            }
            "denySender" -> {
                SmsQueues.deny(context, call.argument<String>("sender") ?: "")
                result.success(true)
            }
            "pending" -> result.success(normalizeQueue(prefs.getString("queue", "[]")).toString())
            "clearPending" -> {
                prefs.edit().putString("queue", "[]").apply()
                result.success(true)
            }
            "ack" -> {
                SmsQueues.remove(context, stringList(call.argument<List<*>>("ids")))
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
        val sender = call.argument<String>("sender")
        result.success(SmsQueues.importInbox(context, from, to, sender).toString())
        SmsSyncScheduler.enqueueUpload(context)
    }

    private fun currentPermission(): String {
        val context = app ?: return "unavailable"
        if (hasSmsPermissions(context)) return "granted"
        val host = activity ?: return "denied"
        val prefs = context.getSharedPreferences(SmsQueues.PREFS, Context.MODE_PRIVATE)
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

    private fun contextOptedIn(context: Context): Boolean =
        context.getSharedPreferences(SmsQueues.PREFS, Context.MODE_PRIVATE).getBoolean("opt_in", false)

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
