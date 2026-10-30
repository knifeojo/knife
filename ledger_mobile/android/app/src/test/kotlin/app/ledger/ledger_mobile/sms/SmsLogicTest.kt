package app.ledger.ledger_mobile.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Queue, retry, and dedup decisions plus the financial classifier.
 * Synthetic texts only. Run with JUnit, or `java -cp ... app.ledger.ledger_mobile.sms.SmsLogicTestKt`.
 */
class SmsLogicTest {
    @Test
    fun classifierMatchesTheDartMirror() {
        val gt = "Acct:******1234\nAmt:NGN3,450.00 DR\nDesc:POS PURCHASE\nBal:NGN10,000.00"
        val gtClass = classifyFinancialSms("GTBank", gt)
        assertEquals("financial", gtClass.reason)
        assertEquals(11, gtClass.score)
        assertEquals(SenderAction.UPLOAD, senderAction("GTBank", gt))

        val ren =
            "Credit of NGN15,000.00 into wallet ****4821. Avl Bal: NGN27,430.50. Desc: WALLET FUNDING FROM EMPLOYER"
        val renClass = classifyFinancialSms("Renmoney", ren)
        assertEquals("financial", renClass.reason)
        assertEquals(10, renClass.score)
        assertEquals(SenderAction.ASK, senderAction("Renmoney", ren))
        assertEquals(SenderAction.UPLOAD, senderAction("Renmoney", ren, approved = true))
        assertEquals(SenderAction.DROP, senderAction("Renmoney", ren, denied = true))

        assertEquals(
            "otp",
            classifyFinancialSms("GTBank", "Your OTP is 482193. Do not share this code with anyone.").reason,
        )
        assertEquals(
            "otp",
            classifyFinancialSms("Renmoney", "Your verification code is 849201. It expires in 5 minutes.").reason,
        )
        assertEquals(
            "promo",
            classifyFinancialSms(
                "GTBank",
                "Congratulations! You have a loan offer up to N300,000. Dial *894*11#",
            ).reason,
        )
        assertEquals(
            "telco",
            classifyFinancialSms("MTN", "Congratulations! You have won N500,000. Dial *123# to claim.").reason,
        )
        assertEquals("telco", classifyFinancialSms("Airtel", "promo").reason)
        assertEquals("personal", classifyFinancialSms("+2348012345678", "I sent you NGN5,000 for lunch").reason)
        assertEquals("personal", classifyFinancialSms("08031234567", "See you at 6").reason)
        assertEquals(
            "low_score",
            classifyFinancialSms("Renmoney", "Hello, your statement is ready in the app").reason,
        )
        val loan =
            "Renmoney: Your loan outstanding balance is NGN150,000.00. Instalment 3 of 12. Amount due NGN18,500.00. Due date 15 Nov 2026."
        assertEquals("loan_status", classifyFinancialSms("Renmoney", loan).reason)
        assertEquals(SenderAction.UPLOAD, senderAction("Renmoney", loan, approved = true))
        assertEquals(
            "financial",
            classifyFinancialSms(
                "Renmoney",
                "Debit of NGN18,500.00 from ****4821. Bal: NGN200,000.00. Desc: LOAN REPAYMENT",
            ).reason,
        )

        assertTrue(
            classifyFinancialSms(
                "FirstBank",
                "Debit: 301XXXX123 Amt: NGN12,500.00 Desc: POS SHOP Bal: NGN41,280.44CR. Dial *894*11# to get loan",
            ).financial,
        )

        assertEquals(
            "telco",
            classifyFinancialSms("Globacom", "Your data bundle of 1.5GB is active. Dial *123#").reason,
        )
        assertEquals(
            "telco",
            classifyFinancialSms("Glo Nigeria", "You have successfully recharged NGN500 airtime.").reason,
        )
        assertEquals("telco", classifyFinancialSms("AirtelNG", "Data plan NGN1,500 activated. Bal NGN2,000.").reason)
        assertEquals("telco", classifyFinancialSms("9mobile", "Airtime recharge of NGN200 was successful.").reason)
        assertEquals(
            "telco",
            classifyFinancialSms("Info", "Your data bundle of NGN1,500 is active. Bal: NGN2,000.00").reason,
        )
        assertEquals("telco", classifyFinancialSms("Info", "NGN1,500 debited for a data bundle.").reason)
        val airtimeDebit = "Acct:******1234\nAmt:NGN500.00 DR\nDesc: AIRTIME\nBal:NGN9,500.00"
        assertEquals("financial", classifyFinancialSms("GTBank", airtimeDebit).reason)
        assertEquals(SenderAction.UPLOAD, senderAction("GTBank", airtimeDebit))
    }

    @Test
    fun queueRetriesAndDedups() {
        val item = UploadItem(
            id = "src-1",
            sender = "Renmoney",
            body = "Credit of NGN15,000.00 into wallet ****4821. Avl Bal: NGN27,430.50. Desc: WALLET FUNDING",
            receivedAtMillis = 1728314220000L,
        )
        val queue = UploadQueue()
        assertTrue(queue.add(item))
        assertFalse(queue.add(item.copy()))
        assertEquals(1, queue.list().size)

        val failed = flushUploads(queue.list()) { throw java.io.IOException("offline") }
        assertTrue(failed.removeIds.isEmpty())
        assertTrue(failed.retry)
        assertEquals(1, queue.list().size)

        val serverDown = flushUploads(queue.list()) { HttpReply(503, """{"error":"down"}""") }
        assertTrue(serverDown.removeIds.isEmpty())
        assertTrue(serverDown.retry)

        val created = flushUploads(queue.list()) {
            HttpReply(200, """{"results":[{"status":"created","transactionId":"t1"}]}""")
        }
        assertEquals(setOf("src-1"), created.removeIds)
        assertFalse(created.retry)
        queue.remove(created.removeIds)
        assertTrue(queue.list().isEmpty())

        assertTrue(queue.add(item))
        val duplicate = flushUploads(queue.list()) {
            HttpReply(200, """{"results":[{"status":"duplicate"}]}""")
        }
        assertEquals(setOf("src-1"), duplicate.removeIds)
        queue.remove(duplicate.removeIds)

        val payload = payloadJson(listOf(item))
        assertTrue(payload.contains("\"sourceId\":\"src-1\""))
        assertTrue(payload.contains("2024-10-07T15:17:00.000Z"))
        assertEquals("http://100.64.0.8:3000/api/v1/alerts/sms", alertsUrl("http://100.64.0.8:3000/"))
        assertEquals(null, alertsUrl("not a url"))
    }

    @Test
    fun partialBatchKeepsOnlyUnconfirmedRows() {
        val ok = UploadItem("ok", "GTBank", "Amt:NGN1.00 DR", 1L)
        val held = UploadItem("held", "FirstBank", "Debit NGN2.00", 2L)
        val decision = flushUploads(listOf(ok, held)) { json ->
            if (json.contains(""""sourceId":"ok"""") && json.contains(""""sourceId":"held"""")) {
                HttpReply(200, """{"results":[{"status":"created"},{"status":""}]}""")
            } else {
                HttpReply(500, "no")
            }
        }
        assertTrue(decision.removeIds.isEmpty())
        assertTrue(decision.retry)
    }

    @Test
    fun pushDropsExcludedAppsAndAsksOnce() {
        val debit = "Acct:******1234\nAmt:NGN1.00 DR\nBal:NGN10.00"
        assertTrue(isExcludedPushPackage("com.whatsapp"))
        assertTrue(isExcludedPushPackage("com.mtn.nigeria"))
        assertTrue(isExcludedPushPackage("app.ledger.ledger_mobile"))
        assertEquals(PushDecision.DROP, decidePush("com.whatsapp", debit, approved = false, denied = false))
        assertEquals(PushDecision.DROP, decidePush("com.example.gtbank", "Hello from the app", approved = false, denied = false))
        assertEquals(PushDecision.ASK, decidePush("com.example.gtbank", debit, approved = false, denied = false))
        assertEquals(PushDecision.UPLOAD, decidePush("com.example.gtbank", debit, approved = true, denied = false))
        assertEquals(PushDecision.DROP, decidePush("com.example.gtbank", debit, approved = true, denied = true))
        assertEquals(
            "b5fed7a40751a36100ca7eeb5d7e2421b7c44bf99d418e6c8fd6715d5e3f4e42",
            pushSourceId("com.example.gtbank", 1728314220000L, "Amt:NGN1.00 DR"),
        )
        val payload = payloadJson(
            listOf(UploadItem("src-push", "GTBank", "Amt:NGN1.00 DR", 1728314220000L)),
            channel = "push",
        )
        assertTrue(payload.contains("\"channel\":\"push\""))
        assertFalse(payloadJson(listOf(UploadItem("src-sms", "GTBank", "Amt:NGN1.00 DR", 1L))).contains("channel"))
    }
}

fun main() {
    org.junit.runner.JUnitCore.main(SmsLogicTest::class.java.name)
}
