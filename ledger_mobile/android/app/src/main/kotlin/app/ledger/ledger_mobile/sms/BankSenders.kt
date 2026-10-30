package app.ledger.ledger_mobile.sms

/**
 * Single Kotlin source for sender lists.
 *
 * [known] auto-accepts a sender (no "Track texts from X?" prompt). It is not the upload gate.
 * [FinancialSms] decides which texts are financial. Add a bank id here; do not scatter ids.
 *
 * The Dart copy is `defaultBankSenders` / `defaultBlockedSenders` in `lib/alerts/senders.dart`.
 */
object BankSenders {
    val known: List<String> = listOf(
        "GTBank",
        "GTWorld",
        "FirstBank",
        "STERLING",
        "Sterling",
        "PROVIDUS",
    )

    val blocked: List<String> = listOf(
        "303",
        "GloDataSale",
        "GLO-ROAM",
        "VIDEO",
        "getmigo",
        "MYD ALERT",
        "MTN",
        "Airtel",
        "9mobile",
        "Glo",
    )

    private val knownNorm = known.map { it.lowercase() }.toSet()
    private val blockedNorm = blocked.map { it.lowercase() }.toSet()

    fun isKnown(sender: String): Boolean = sender.trim().lowercase() in knownNorm

    fun isBlocked(sender: String): Boolean = sender.trim().lowercase() in blockedNorm

    /** Known bank id. Phones and telcos are never known. Kept for call sites that mean "auto-accept". */
    fun isAllowed(sender: String): Boolean = isKnown(sender)
}
