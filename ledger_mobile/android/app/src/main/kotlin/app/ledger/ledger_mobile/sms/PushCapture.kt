package app.ledger.ledger_mobile.sms

import android.os.Handler
import android.os.Looper

/** Notifies Flutter when a financial app alert was queued or is waiting for a yes. */
object PushCapture {
    var onQueued: (() -> Unit)? = null

    fun queued() {
        val callback = onQueued ?: return
        if (Looper.myLooper() == Looper.getMainLooper()) {
            callback()
        } else {
            Handler(Looper.getMainLooper()).post { callback() }
        }
    }
}
