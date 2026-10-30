package app.ledger.ledger_mobile.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class AppUpdateLogicTest {
    @Test
    fun onlyAHigherBuildIsAnUpdate() {
        assertTrue(isNewerBuild(5, 6))
        assertFalse(isNewerBuild(6, 6))
        assertFalse(isNewerBuild(7, 6))
    }

    @Test
    fun sha256AndSizeMustMatch() {
        val bytes = "synthetic-apk-not-a-real-package".toByteArray()
        val sha = sha256Hex(bytes)
        assertEquals("abc".let { sha256Hex(it.toByteArray()) }, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        val file = Files.createTempFile("ledger-update", ".apk").toFile()
        file.writeBytes(bytes)
        val release = ReleaseInfo("0.3.3", 6, sha, bytes.size.toLong())
        assertTrue(fileMatches(release, file))
        assertFalse(fileMatches(release.copy(sha256 = "a".repeat(64)), file))
        assertFalse(fileMatches(release.copy(size = bytes.size.toLong() + 1), file))
        file.delete()
    }

    @Test
    fun urlsUseTheServerOrigin() {
        assertEquals("http://100.64.0.8:3000/api/v1/app/latest", appLatestUrl("http://100.64.0.8:3000/"))
        assertEquals("http://100.64.0.8:3000/api/v1/app/apk", appApkUrl("http://100.64.0.8:3000"))
        assertEquals(null, appLatestUrl("not a url"))
    }
}

fun main() {
    org.junit.runner.JUnitCore.main(AppUpdateLogicTest::class.java.name)
}
