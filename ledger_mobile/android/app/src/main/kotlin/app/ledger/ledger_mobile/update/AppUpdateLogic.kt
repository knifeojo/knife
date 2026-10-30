package app.ledger.ledger_mobile.update

import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/**
 * Pure update rules. A release is offered only when its buildNumber is greater than the
 * installed versionCode, and the downloaded bytes match the published size and sha256.
 */
data class ReleaseInfo(
    val version: String,
    val buildNumber: Int,
    val sha256: String,
    val size: Long,
)

fun isNewerBuild(localBuild: Int, remoteBuild: Int): Boolean = remoteBuild > localBuild

fun appLatestUrl(base: String): String? = appPath(base, "/api/v1/app/latest")

fun appApkUrl(base: String): String? = appPath(base, "/api/v1/app/apk")

private fun appPath(base: String, path: String): String? {
    val trimmed = base.trim().trimEnd('/')
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null
    return trimmed + path
}

fun sha256Hex(bytes: ByteArray): String = sha256Hex(bytes.inputStream(), bytes.size.toLong()).second

/** Hashes [input] and counts bytes. The digest is lowercase hex. */
fun sha256Hex(input: InputStream, expectedSize: Long? = null): Pair<Long, String> {
    val digest = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(8192)
    var count = 0L
    while (true) {
        val n = input.read(buf)
        if (n < 0) break
        digest.update(buf, 0, n)
        count += n
    }
    if (expectedSize != null && count != expectedSize) return count to ""
    return count to hex(digest.digest())
}

fun fileMatches(release: ReleaseInfo, file: File): Boolean {
    if (!file.isFile || file.length() != release.size) return false
    val (count, sha) = file.inputStream().use { sha256Hex(it) }
    return count == release.size && sha.equals(release.sha256, ignoreCase = true)
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
