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
        assertTrue(
            classifyFinancialSms(
                "FirstBank",
                "Debit: 301XXXX123 Amt: NGN12,500.00 Desc: POS SHOP Bal: NGN41,280.44CR. Dial *894*11# to get loan",
            ).financial,
        )
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
}

fun main() {
    org.junit.runner.JUnitCore.main(SmsLogicTest::class.java.name)
}
