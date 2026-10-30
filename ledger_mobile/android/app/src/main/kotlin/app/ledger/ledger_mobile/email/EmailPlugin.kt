package app.ledger.ledger_mobile.email

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/** Opens Sign in with Google in the browser. The callback is the public Ledger URL. */
class EmailPlugin : FlutterPlugin, MethodChannel.MethodCallHandler, ActivityAware {
    private var app: Context? = null
    private var activity: Activity? = null
    private var channel: MethodChannel? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        app = binding.applicationContext
        val messenger = MethodChannel(binding.binaryMessenger, "ledger/email")
        channel = messenger
        messenger.setMethodCallHandler(this)
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
        if (call.method != "open") {
            result.notImplemented()
            return
        }
        val url = call.argument<String>("url")?.trim().orEmpty()
        if (!url.startsWith("https://")) {
            result.error("bad_url", "Sign in with Google needs an https link", null)
            return
        }
        val context = app
        if (context == null) {
            result.error("no_context", "Email plugin is not attached", null)
            return
        }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        val host = activity
        if (host != null) {
            host.startActivity(intent)
        } else {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        }
        result.success(true)
    }
}
