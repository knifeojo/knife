package app.ledger.ledger_mobile.sms

import java.security.MessageDigest

/**
 * Stable id shared with Dart `smsSourceId`.
 * Vector: sender GTBank, millis 1728314220000, body "Amt:NGN1.00 DR"
 * → 07a201ac2b63604ba6c95c53591dcfa22a4f637cafe494fe1e1e87ffa79486b6
 *
 * Do not log [body].
 */
fun smsSourceId(sender: String, body: String, receivedAtMillis: Long): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(
        "sms|$sender|$receivedAtMillis|$body".toByteArray(Charsets.UTF_8),
    )
    val hex = "0123456789abcdef"
    val out = StringBuilder(digest.size * 2)
    for (b in digest) {
        val value = b.toInt() and 0xff
        out.append(hex[value ushr 4])
        out.append(hex[value and 0x0f])
    }
    return out.toString()
}
