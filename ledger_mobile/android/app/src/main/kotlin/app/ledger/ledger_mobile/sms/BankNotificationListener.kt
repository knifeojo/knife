package app.ledger.ledger_mobile.sms

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Optional fallback when SMS permission is unavailable: listen for bank-app push notifications.
 * Stubbed — not enabled in the manifest. Wire package names (GTBank, FirstBank, Sterling) here
 * once we have samples of those notification texts.
 */
class BankNotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        // TODO: filter by bank app package, parse title/text with the same registry, enqueue.
    }
}
