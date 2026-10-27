package app.ledger.ledger_mobile.sms

object BankSenders {
    val allowed = setOf("gtbank", "gtworld", "firstbank", "sterling", "providus")
    private val blocked = setOf("303", "glodatasale", "glo-roam", "video", "getmigo", "myd alert", "mtn", "airtel", "9mobile", "glo")
    private val phone = Regex("""^\+?\d{8,15}$""")

    fun isAllowed(sender: String): Boolean {
        val n = sender.trim().lowercase()
        if (n.isEmpty() || phone.matches(n.replace(Regex("""[\s()-]"""), "")) || n in blocked) return false
        return n in allowed
    }
}
