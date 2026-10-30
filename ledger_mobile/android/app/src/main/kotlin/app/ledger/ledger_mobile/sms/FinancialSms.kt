package app.ledger.ledger_mobile.sms

/**
 * On-device financial SMS classifier.
 *
 * Mirror of `ledger_mobile/lib/alerts/classifier.dart`. Keep the weights, threshold,
 * exclusions, and reason strings identical. Do not add banks here; known ids live in [BankSenders].
 *
 * Score (financial when score >= [THRESHOLD] and nothing excludes the text):
 * - currency amount (NGN, ₦, N, USD, GBP, EUR, $, £, €): +3
 * - debit/credit/DR/CR/spent/money in/out/has arrived: +2
 * - txn/transfer/POS: +1
 * - balance/Bal/Avl: +2
 * - masked account: +2
 * - alphanumeric bank-style sender id: +1
 *
 * Exclusions win: OTP, promo (unless a real amount sits with a direction or a balance),
 * personal phone chats, telco/promo sender ids.
 * Known banks skip the prompt. A new sender that scores as financial is [SenderAction.ASK].
 */
const val FINANCIAL_SCORE_THRESHOLD = 5

enum class SenderAction { UPLOAD, ASK, DROP }

data class SmsClassification(
    val financial: Boolean,
    val score: Int,
    val reason: String,
)

private val phoneRegex = Regex("""^\+?\d{8,15}$""")
private val currencyRegex = Regex(
    """(?:NGN|USD|GBP|EUR|₦|[$£€])\s*[\d,]+(?:\.\d{1,2})?|\bN\s?[\d]{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\bN\s?\d+\.\d{2}\b""",
    RegexOption.IGNORE_CASE,
)
private val directionRegex = Regex(
    """\b(debit(?:ed)?|credit(?:ed)?|dr|cr|money\s+out|money\s+in|spent|has arrived|withdrawn)\b""",
    RegexOption.IGNORE_CASE,
)
private val txnRegex = Regex(
    """\b(txn|transaction|transfer(?:red)?|nip|pos)\b""",
    RegexOption.IGNORE_CASE,
)
private val balanceRegex = Regex(
    """\b(balance|bal|avl|avail(?:able)?)\b""",
    RegexOption.IGNORE_CASE,
)
private val maskedRegex = Regex(
    """(?:\*{2,}|x{2,})\d{2,6}|\d{3,}x{2,}\d{2,4}|(?:acct|account|a/c)\s*[:\s]*[*x\d]{4,}""",
    RegexOption.IGNORE_CASE,
)
private val letterRegex = Regex("""[A-Za-z]""")
private val otpRegex = Regex(
    """\b(otp|one[-\s]?time (?:password|pin|code)|verification code|do not share(?: this)? (?:code|otp)|your code is)\b|\b(?:code|otp)\s*(?:is|:)\s*\d{4,8}\b""",
    RegexOption.IGNORE_CASE,
)
private val promoRegex = Regex(
    """congratulations! you have a loan offer|alwayson overdraft|keep transacting|you have won|dial \*\d|unsubscribe|limited time offer|data bundle""",
    RegexOption.IGNORE_CASE,
)

fun isPersonalSender(sender: String): Boolean {
    val stripped = sender.trim().replace(Regex("""[\s()-]"""), "")
    return phoneRegex.matches(stripped)
}

fun isBankStyleSender(sender: String): Boolean {
    val n = sender.trim()
    if (n.length < 3 || n.length > 11) return false
    if (n.any { it.isWhitespace() }) return false
    if (!letterRegex.containsMatchIn(n)) return false
    if (isPersonalSender(n) || BankSenders.isBlocked(n)) return false
    return true
}

fun classifyFinancialSms(sender: String, body: String): SmsClassification {
    val trimmed = sender.trim()
    if (trimmed.isEmpty()) return SmsClassification(false, 0, "low_score")
    if (isPersonalSender(trimmed)) return SmsClassification(false, 0, "personal")
    if (BankSenders.isBlocked(trimmed)) return SmsClassification(false, 0, "telco")
    if (otpRegex.containsMatchIn(body)) return SmsClassification(false, 0, "otp")
    val currency = currencyRegex.containsMatchIn(body)
    val direction = directionRegex.containsMatchIn(body)
    val balance = balanceRegex.containsMatchIn(body)
    if (promoRegex.containsMatchIn(body) && !(currency && (direction || balance))) {
        return SmsClassification(false, 0, "promo")
    }
    var score = 0
    if (currency) score += 3
    if (direction) score += 2
    if (txnRegex.containsMatchIn(body)) score += 1
    if (balance) score += 2
    if (maskedRegex.containsMatchIn(body)) score += 2
    if (isBankStyleSender(trimmed)) score += 1
    val financial = score >= FINANCIAL_SCORE_THRESHOLD
    return SmsClassification(financial, score, if (financial) "financial" else "low_score")
}

fun senderAction(
    sender: String,
    body: String,
    known: Boolean = BankSenders.isKnown(sender),
    approved: Boolean = false,
    denied: Boolean = false,
): SenderAction {
    if (!classifyFinancialSms(sender, body).financial) return SenderAction.DROP
    if (known || approved) return SenderAction.UPLOAD
    if (denied) return SenderAction.DROP
    return SenderAction.ASK
}
