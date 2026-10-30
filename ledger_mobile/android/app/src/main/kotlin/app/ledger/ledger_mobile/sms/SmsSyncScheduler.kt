package app.ledger.ledger_mobile.sms

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Uploads the native SMS queue without a running Flutter engine.
 * One-time work is expedited, requires a network, and backs off exponentially.
 * A 15-minute periodic job (the Android minimum) retries anything still queued.
 */
internal object SmsSyncScheduler {
    private const val UPLOAD = "ledger-sms-upload"
    private const val PERIODIC = "ledger-sms-periodic"

    private fun constraints() = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    fun enqueueUpload(context: Context) {
        val app = context.applicationContext
        val request = OneTimeWorkRequestBuilder<SmsUploadWorker>()
            .setConstraints(constraints())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(app).enqueueUniqueWork(UPLOAD, ExistingWorkPolicy.REPLACE, request)
        ensurePeriodic(app)
    }

    fun ensurePeriodic(context: Context) {
        val app = context.applicationContext
        val request = PeriodicWorkRequestBuilder<SmsUploadWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(app).enqueueUniquePeriodicWork(
            PERIODIC,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    fun cancel(context: Context) {
        val wm = WorkManager.getInstance(context.applicationContext)
        wm.cancelUniqueWork(UPLOAD)
        wm.cancelUniqueWork(PERIODIC)
    }
}
