package app.ledger.ledger_mobile.update

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.ledger.ledger_mobile.MainActivity

/**
 * One local notification per cleared loan. The id is remembered in [PREFS] so a later
 * overview refresh does not notify again. A loan that was already finished when first
 * detected is not sent here (the server marks it silent and leaves it off the card list).
 */
internal object LoanNotices {
    private const val PREFS = "ledger_notices"
    private const val SEEN = "seen"
    private const val CHANNEL = "ledger_loans"

    fun show(context: Context, id: String, text: String): String {
        if (id.isBlank() || text.isBlank()) return "failed"
        val app = context.applicationContext
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val seen = prefs.getStringSet(SEEN, emptySet())?.toSet() ?: emptySet()
        if (id in seen) return "duplicate"
        if (!post(app, id, text)) return "failed"
        prefs.edit().putStringSet(SEEN, seen + id).commit()
        return "shown"
    }

    private fun post(context: Context, id: String, text: String): Boolean {
        if (Build.VERSION.SDK_INT >= 33) {
            val granted = context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!granted) return false
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL, "Loans", NotificationManager.IMPORTANCE_DEFAULT)
            manager?.createNotificationChannel(channel)
        }
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pending = PendingIntent.getActivity(
            context,
            id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Loan cleared")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(id.hashCode(), notification)
        return true
    }
}
