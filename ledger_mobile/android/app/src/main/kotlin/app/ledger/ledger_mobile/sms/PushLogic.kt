package app.ledger.ledger_mobile.sms

import java.security.MessageDigest

/**
 * On-device gate for notifications posted by other apps.
 * Financial texts use the same classifier as SMS. Messaging, social, telco and Ledger itself never upload.
 * A new app asks once. Do not log notification text.
 */
enum class PushDecision { UPLOAD, ASK, DROP }

private val excludedFragments = listOf(
    "whatsapp",
    "telegram",
    "instagram",
    "facebook",
    "messenger",
    "snapchat",
    "signal",
    "tiktok",
    "musically",
    "slack",
    "discord",
    "linkedin",
    "truecaller",
    "wechat",
    ".imo.",
    "messaging",
    ".mms",
    "globacom",
    "gloworld",
    "glodata",
    "mtn",
    "airtel",
    "9mobile",
    "ninemobile",
    "etisalat",
)

fun isExcludedPushPackage(packageName: String): Boolean {
    val name = packageName.trim().lowercase()
    if (name.isEmpty()) return true
    if (name == "app.ledger.ledger_mobile" || name.startsWith("app.ledger.")) return true
    return excludedFragments.any { name.contains(it) }
}

fun decidePush(packageName: String, text: String, approved: Boolean, denied: Boolean): PushDecision {
    if (isExcludedPushPackage(packageName)) return PushDecision.DROP
    if (!classifyFinancialSms(packageName, text).financial) return PushDecision.DROP
    if (denied) return PushDecision.DROP
    if (approved) return PushDecision.UPLOAD
    return PushDecision.ASK
}

/** Stable id: hash(package + postTime + text). Shared with Dart `pushSourceId`. */
fun pushSourceId(packageName: String, postTimeMillis: Long, text: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(
        "push|$packageName|$postTimeMillis|$text".toByteArray(Charsets.UTF_8),
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
