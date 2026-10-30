package app.ledger.ledger_mobile.update

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

internal object AppUpdateScheduler {
    private const val DAILY = "ledger-app-update"

    fun ensureDaily(context: Context) {
        val request = PeriodicWorkRequestBuilder<AppUpdateWorker>(24, TimeUnit.HOURS)
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
            DAILY,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }
}
