package app.ledger.ledger_mobile.sms

import android.content.Context

/**
 * Reads the same store the Flutter app writes.
 *
 * `SharedPreferences.getInstance()` (shared_preferences 2.5.x) writes strings through the
 * legacy Android backend, file `FlutterSharedPreferences`. Dart adds the prefix `flutter.`
 * before the key is stored, so `server_url` lives at `flutter.server_url`.
 * This is not the DataStore backend used by `SharedPreferencesAsync`.
 * Ledger's [app.ledger.ledger_mobile] settings use:
 * - `server_url` → `flutter.server_url` (SettingsStore.serverUrlKey)
 * - `session_token` → `flutter.session_token` (SettingsStore.tokenKey)
 * - `sms_outbox` → `flutter.sms_outbox` (SmsOutbox.storageKey), drained into the native queue
 * - `sms_captured`, `sms_sent`, `sms_last_sync` → the Bank alerts counts and Last synced time
 *
 * The background worker reads these after the Flutter engine is gone. Do not log the token or SMS bodies.
 */
internal object FlutterPrefs {
    const val FILE = "FlutterSharedPreferences"
    const val PREFIX = "flutter."

    const val SERVER_URL = "server_url"
    const val TOKEN = "session_token"
    const val OUTBOX = "sms_outbox"
    const val CAPTURED = "sms_captured"
    const val SENT = "sms_sent"
    const val LAST_SYNC = "sms_last_sync"

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun getString(context: Context, key: String): String? = prefs(context).getString(PREFIX + key, null)

    fun putString(context: Context, key: String, value: String) {
        prefs(context).edit().putString(PREFIX + key, value).commit()
    }

    fun bump(context: Context, key: String, by: Int) {
        if (by <= 0) return
        val current = getString(context, key)?.toIntOrNull() ?: 0
        putString(context, key, (current + by).toString())
    }
}
