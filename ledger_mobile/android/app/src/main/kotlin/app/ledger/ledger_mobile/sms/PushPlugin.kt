package app.ledger.ledger_mobile.sms

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.provider.Settings
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/** Flutter bridge for notification access and the per-app "Track alerts from App?" choice. */
class PushPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware {
    private var channel: MethodChannel? = null
    private var app: Context? = null
    private var activity: Activity? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        app = binding.applicationContext
        val messenger = MethodChannel(binding.binaryMessenger, "ledger/push")
        channel = messenger
        messenger.setMethodCallHandler(this)
        PushCapture.onQueued = {
            channel?.invokeMethod("onCaptured", null)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        PushCapture.onQueued = null
        channel?.setMethodCallHandler(null)
        channel = null
        app = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivityForConfigChanges() {
        activity = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivity() {
        activity = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val context = app
        if (context == null) {
            result.error("no_context", "Push plugin is not attached", null)
            return
        }
        when (call.method) {
            "enabled" -> result.success(notificationAccessEnabled(context))
            "openSettings" -> {
                openListenerSettings(context)
                result.success(true)
            }
            "pendingApps" -> {
                result.success(
                    PushQueues.pendingApps(context).map { (packageName, label) ->
                        mapOf("package" to packageName, "label" to label)
                    },
                )
            }
            "approve" -> {
                val packageName = call.argument<String>("package") ?: ""
                PushQueues.approve(context, packageName)
                SmsSyncScheduler.enqueueUpload(context)
                result.success(true)
            }
            "deny" -> {
                PushQueues.deny(context, call.argument<String>("package") ?: "")
                result.success(true)
            }
            else -> result.notImplemented()
        }
    }

    private fun openListenerSettings(context: Context) {
        val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        val host = activity
        if (host != null) {
            host.startActivity(intent)
        } else {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
    }

    companion object {
        fun notificationAccessEnabled(context: Context): Boolean {
            val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
                ?: return false
            val pkg = context.packageName
            return flat.split(":").any { entry ->
                val name = entry.trim()
                name == pkg || name.startsWith("$pkg/")
            }
        }
    }
}
