package app.ledger.ledger_mobile.sms

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/** Drains the on-device SMS queue. Safe to run while the Flutter process is dead. */
class SmsUploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val sms = SmsSyncRunner.upload(applicationContext)
        val push = PushSyncRunner.upload(applicationContext)
        return if (sms.retry || push.retry) Result.retry() else Result.success()
    }
}
