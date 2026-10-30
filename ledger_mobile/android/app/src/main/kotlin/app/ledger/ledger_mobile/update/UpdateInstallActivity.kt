package app.ledger.ledger_mobile.update

import android.app.Activity
import android.os.Bundle

/** Notification tap. Starts the package installer and closes immediately. */
class UpdateInstallActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppUpdateInstaller.launch(this)
        finish()
    }
}
