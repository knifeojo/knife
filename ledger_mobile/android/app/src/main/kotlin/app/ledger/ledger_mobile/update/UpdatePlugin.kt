package app.ledger.ledger_mobile.update

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class UpdatePlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware {
    private var channel: MethodChannel? = null
    private var app: Context? = null
    private var activity: Activity? = null
    private var askedNotify = false

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        app = binding.applicationContext
        val messenger = MethodChannel(binding.binaryMessenger, "ledger/update")
        channel = messenger
        messenger.setMethodCallHandler(this)
        AppUpdateScheduler.ensureDaily(binding.applicationContext)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
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
            result.error("no_context", "Update plugin is not attached", null)
            return
        }
        when (call.method) {
            "ensureDaily" -> {
                AppUpdateScheduler.ensureDaily(context)
                result.success(true)
            }
            "ready" -> result.success(AppUpdateRunner.storedStatus(context).toMap())
            "install" -> {
                AppUpdateInstaller.launch(activity ?: context)
                result.success(true)
            }
            "showNotice" -> {
                val id = call.argument<String>("id")?.trim().orEmpty()
                val text = call.argument<String>("text")?.trim().orEmpty()
                if (id.length > 80 || text.length > 240) {
                    result.success("failed")
                    return
                }
                result.success(LoanNotices.show(context, id, text))
            }
            "check" -> {
                askNotify()
                val reply = result
                Thread {
                    val status = try {
                        AppUpdateRunner.check(context)
                    } catch (_: Exception) {
                        AppUpdateRunner.storedStatus(context)
                    }
                    Handler(Looper.getMainLooper()).post {
                        try {
                            reply.success(status.toMap())
                        } catch (_: Exception) {
                            // The engine was detached before the check finished.
                        }
                    }
                }.start()
            }
            else -> result.notImplemented()
        }
    }

    private fun askNotify() {
        if (askedNotify || Build.VERSION.SDK_INT < 33) return
        val host = activity ?: return
        if (ContextCompat.checkSelfPermission(host, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return
        }
        askedNotify = true
        ActivityCompat.requestPermissions(host, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFY)
    }

    companion object {
        private const val REQUEST_NOTIFY = 41034
    }
}
