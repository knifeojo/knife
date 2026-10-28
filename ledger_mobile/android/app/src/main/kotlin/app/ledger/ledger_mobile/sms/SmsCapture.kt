package app.ledger.ledger_mobile.sms

import android.os.Handler
import android.os.Looper

/** Notifies Flutter when a bank SMS was queued. No-op if the engine is not attached. */
object SmsCapture {
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
