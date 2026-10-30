package app.ledger.ledger_mobile

import app.ledger.ledger_mobile.email.EmailPlugin
import app.ledger.ledger_mobile.sms.PushPlugin
import app.ledger.ledger_mobile.sms.SmsPlugin
import app.ledger.ledger_mobile.update.UpdatePlugin
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        flutterEngine.plugins.add(SmsPlugin())
        flutterEngine.plugins.add(PushPlugin())
        flutterEngine.plugins.add(EmailPlugin())
        flutterEngine.plugins.add(UpdatePlugin())
    }
}
