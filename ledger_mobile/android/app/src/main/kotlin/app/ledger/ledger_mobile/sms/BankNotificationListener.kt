package app.ledger.ledger_mobile.sms

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Reads notifications other apps post. Non-financial text is dropped here and never uploaded.
 * A new financial app is held until the user answers "Track alerts from App?".
 */
class BankNotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null || sbn.isOngoing) return
        val packageName = sbn.packageName ?: return
        val text = notificationText(sbn.notification) ?: return
        val label = appLabel(packageName)
        val decision = PushQueues.handlePosted(this, packageName, label, text, sbn.postTime)
        if (decision == PushDecision.UPLOAD) SmsSyncScheduler.enqueueUpload(this)
        if (decision == PushDecision.ASK || decision == PushDecision.UPLOAD) PushCapture.queued()
    }

    private fun appLabel(packageName: String): String {
        return try {
            val info = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationLabel(info).toString()
        } catch (_: Exception) {
            packageName
        }
    }

    private fun notificationText(notification: Notification?): String? {
        if (notification == null) return null
        val extras = notification.extras ?: return null
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        val big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
        val body = listOf(title, big.ifBlank { text }).filter { it.isNotBlank() }.joinToString("\n").trim()
        return body.ifBlank { null }
    }
}
