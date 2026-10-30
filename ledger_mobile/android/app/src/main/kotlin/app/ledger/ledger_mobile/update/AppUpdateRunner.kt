package app.ledger.ledger_mobile.update

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.ledger.ledger_mobile.sms.FlutterPrefs
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Checks GET /api/v1/app/latest with the session token, downloads a newer APK, and keeps it
 * only when the sha256 and size match. The session token and APK bytes are not logged.
 */
internal object AppUpdateRunner {
    private const val TAG = "LedgerUpdate"
    private const val PREFS = "ledger_update"
    private const val READY = "ready"
    private const val VERSION = "version"
    private const val BUILD = "build"
    private const val SHA = "sha256"
    private const val NOTIFIED = "notified_build"
    private const val CHANNEL = "ledger_updates"
    private const val NOTIFICATION = 41033
    const val APK_NAME = "ledger-update.apk"

    data class Status(val ready: Boolean, val version: String?, val buildNumber: Int?, val retry: Boolean) {
        fun toMap(): Map<String, Any?> = mapOf(
            "ready" to ready,
            "version" to version,
            "buildNumber" to buildNumber,
        )
    }

    fun check(context: Context): Status {
        val app = context.applicationContext
        val local = installedBuild(app)
        val base = FlutterPrefs.getString(app, FlutterPrefs.SERVER_URL)?.trim().orEmpty()
        val token = FlutterPrefs.getString(app, FlutterPrefs.TOKEN)?.trim().orEmpty()
        val latestUrl = appLatestUrl(base)
        val apkUrl = appApkUrl(base)
        if (latestUrl == null || apkUrl == null || token.isEmpty()) return stored(app, local, retry = false)

        val fetched = try {
            get(latestUrl, token)
        } catch (error: Exception) {
            Log.i(TAG, "update check failed: ${error.javaClass.simpleName}")
            return stored(app, local, retry = true)
        }
        if (fetched.status == 401 || fetched.status == 404) return stored(app, local, retry = false)
        if (fetched.status !in 200..299) return stored(app, local, retry = fetched.status == 429 || fetched.status >= 500)

        val release = parseRelease(fetched.body) ?: return stored(app, local, retry = false)
        if (!isNewerBuild(local, release.buildNumber)) {
            clear(app)
            return Status(false, null, null, retry = false)
        }
        val dest = apkFile(app)
        if (fileMatches(release, dest) && storedSha(app) == release.sha256.lowercase()) {
            markReady(app, release, notify = true)
            return Status(true, release.version, release.buildNumber, retry = false)
        }
        val partial = File(dest.parentFile, "$APK_NAME.partial")
        val downloaded = try {
            download(apkUrl, token, partial, release)
        } catch (error: Exception) {
            Log.i(TAG, "update download failed: ${error.javaClass.simpleName}")
            partial.delete()
            return stored(app, local, retry = true)
        }
        if (!downloaded) {
            partial.delete()
            return stored(app, local, retry = false)
        }
        if (!fileMatches(release, partial)) {
            partial.delete()
            return stored(app, local, retry = false)
        }
        dest.parentFile?.mkdirs()
        if (dest.exists()) dest.delete()
        if (!partial.renameTo(dest)) {
            partial.copyTo(dest, overwrite = true)
            partial.delete()
        }
        markReady(app, release, notify = true)
        return Status(true, release.version, release.buildNumber, retry = false)
    }

    fun storedStatus(context: Context): Status = stored(context.applicationContext, installedBuild(context), retry = false)

    fun apkFile(context: Context): File = File(File(context.applicationContext.filesDir, "updates"), APK_NAME)

    private fun stored(context: Context, local: Int, retry: Boolean): Status {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(READY, false)) return Status(false, null, null, retry)
        val build = prefs.getInt(BUILD, 0)
        val version = prefs.getString(VERSION, null)
        val file = apkFile(context)
        val sha = prefs.getString(SHA, null)
        if (!isNewerBuild(local, build) || version.isNullOrEmpty() || sha.isNullOrEmpty() || !file.isFile) {
            clear(context)
            return Status(false, null, null, retry)
        }
        return Status(true, version, build, retry)
    }

    private fun markReady(context: Context, release: ReleaseInfo, notify: Boolean) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val already = prefs.getInt(NOTIFIED, 0)
        prefs.edit()
            .putBoolean(READY, true)
            .putString(VERSION, release.version)
            .putInt(BUILD, release.buildNumber)
            .putString(SHA, release.sha256.lowercase())
            .commit()
        if (notify && already != release.buildNumber) {
            if (showNotification(context, release)) {
                prefs.edit().putInt(NOTIFIED, release.buildNumber).commit()
            }
        }
    }

    private fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit()
        apkFile(context).delete()
        File(apkFile(context).parentFile, "$APK_NAME.partial").delete()
        NotificationManagerCompat.from(context).cancel(NOTIFICATION)
    }

    private fun storedSha(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(SHA, null)

    private fun showNotification(context: Context, release: ReleaseInfo): Boolean {
        if (Build.VERSION.SDK_INT >= 33) {
            val granted = context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!granted) return false
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT)
            manager?.createNotificationChannel(channel)
        }
        val intent = Intent(context, UpdateInstallActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pending = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Update ready")
            .setContentText("Version ${release.version} is downloaded")
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIFICATION, notification)
        return true
    }

    private fun installedBuild(context: Context): Int {
        val info: PackageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toInt() else @Suppress("DEPRECATION") info.versionCode
    }

    private fun parseRelease(body: String): ReleaseInfo? {
        val obj = try {
            JSONObject(body)
        } catch (_: Exception) {
            return null
        }
        val version = obj.optString("version")
        if (version.isEmpty() || version.length > 40) return null
        if (!obj.has("buildNumber")) return null
        val build = obj.optInt("buildNumber", -1)
        if (build < 1) return null
        val sha = obj.optString("sha256").lowercase()
        if (!Regex("[0-9a-f]{64}").matches(sha)) return null
        val size = obj.optLong("size", -1)
        if (size < 1) return null
        return ReleaseInfo(version, build, sha, size)
    }

    private data class Reply(val status: Int, val body: String)

    private fun get(url: String, token: String): Reply {
        val connection = open(url, token)
        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            return Reply(status, body)
        } finally {
            connection.disconnect()
        }
    }

    private fun download(url: String, token: String, dest: File, release: ReleaseInfo): Boolean {
        dest.parentFile?.mkdirs()
        val connection = open(url, token)
        try {
            val status = connection.responseCode
            if (status == 429 || status >= 500) throw java.io.IOException("status $status")
            if (status !in 200..299) return false
            connection.inputStream.use { input ->
                FileOutputStream(dest).use { output ->
                    val digest = java.security.MessageDigest.getInstance("SHA-256")
                    val buf = ByteArray(8192)
                    var count = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (count + n > release.size) return false
                        digest.update(buf, 0, n)
                        output.write(buf, 0, n)
                        count += n
                    }
                    if (count != release.size) return false
                    val sha = hex(digest.digest())
                    return sha.equals(release.sha256, ignoreCase = true)
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun open(url: String, token: String): HttpURLConnection {
        return (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15_000
            readTimeout = 120_000
            instanceFollowRedirects = true
            setRequestProperty("Accept", "application/json, application/vnd.android.package-archive")
            setRequestProperty("Authorization", "Bearer $token")
        }
    }

    private fun hex(digest: ByteArray): String {
        val alphabet = "0123456789abcdef"
        val out = StringBuilder(digest.size * 2)
        for (b in digest) {
            val value = b.toInt() and 0xff
            out.append(alphabet[value ushr 4])
            out.append(alphabet[value and 0x0f])
        }
        return out.toString()
    }
}
