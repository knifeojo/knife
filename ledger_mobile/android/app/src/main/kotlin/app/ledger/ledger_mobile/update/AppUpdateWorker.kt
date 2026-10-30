package app.ledger.ledger_mobile.update

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/** Daily check. Downloads a newer APK and posts the "Update ready" notification. */
class AppUpdateWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val status = AppUpdateRunner.check(applicationContext)
        return if (status.retry) Result.retry() else Result.success()
    }
}
