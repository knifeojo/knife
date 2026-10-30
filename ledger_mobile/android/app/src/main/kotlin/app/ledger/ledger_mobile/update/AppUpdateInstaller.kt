package app.ledger.ledger_mobile.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider

/** Opens the system package installer for the verified APK, or the one-time unknown-sources screen. */
internal object AppUpdateInstaller {
    fun launch(context: Context) {
        val app = context.applicationContext
        if (Build.VERSION.SDK_INT >= 26 && !app.packageManager.canRequestPackageInstalls()) {
            val settings = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${app.packageName}"))
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(settings)
            return
        }
        val file = AppUpdateRunner.apkFile(app)
        val prefs = app.getSharedPreferences("ledger_update", Context.MODE_PRIVATE)
        val sha = prefs.getString("sha256", null)
        val size = prefs.getInt("build", 0)
        if (!prefs.getBoolean("ready", false) || sha.isNullOrEmpty() || size < 1 || !file.isFile) return
        val release = ReleaseInfo(
            version = prefs.getString("version", "") ?: "",
            buildNumber = size,
            sha256 = sha,
            size = file.length(),
        )
        if (!fileMatches(release, file)) return
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", file)
        val install = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(install)
    }
}
