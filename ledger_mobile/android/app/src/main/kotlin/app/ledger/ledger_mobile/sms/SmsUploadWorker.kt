package app.ledger.ledger_mobile.sms

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/** Drains the on-device SMS queue. Safe to run while the Flutter process is dead. */
class SmsUploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val outcome = SmsSyncRunner.upload(applicationContext)
        return if (outcome.retry) Result.retry() else Result.success()
    }
}
