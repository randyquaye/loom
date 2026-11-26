package dev.loom.app.android.auth

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** The real vault on a real directory; only the device key store is stood in for. */
class FileCredentialVaultTest {
    @get:Rule val folder = TemporaryFolder()

    /** Authenticated sealing with the three ways a device key store can answer. */
    private class FakeKeystore : RecordCipher {
        var unavailable = false
        var keyExists = false
        var destroyed = 0
        private var key: Byte = 0x5a

        private fun tag(body: ByteArray): Byte = body.fold(key.toInt()) { sum, b -> sum * 31 + b }.toByte()

        override fun seal(plain: ByteArray): ByteArray {
            if (unavailable) throw VaultUnavailableException()
            keyExists = true
            val body = ByteArray(plain.size) { (plain[it].toInt() xor key.toInt()).toByte() }
            return body + tag(body)
        }

        override fun open(sealed: ByteArray): ByteArray {
            if (unavailable) throw VaultUnavailableException()
            if (!keyExists || sealed.isEmpty()) throw UnreadableRecordException()
            val body = sealed.copyOf(sealed.size - 1)
            if (tag(body) != sealed.last()) throw UnreadableRecordException()
            return ByteArray(body.size) { (body[it].toInt() xor key.toInt()).toByte() }
        }

        override fun destroy() {
            keyExists = false
            destroyed++
        }
    }

    private val keystore = FakeKeystore()
    private val vault by lazy { FileCredentialVault(folder.root, keystore) }
    private val record get() = File(folder.root, "loom-credentials.v1")
    private val saved = StoredCredentials("loom.example.com", "example.com", "dev@example.com", "refresh/1+x=")

    @Test
    fun savedRecordIsSealedAndReadsBack() = runBlocking {
        assertNull(vault.load())
        vault.save(saved)
        assertFalse(String(record.readBytes(), Charsets.ISO_8859_1).contains("refresh/1"))
        assertEquals(saved, vault.load())
        vault.save(saved.copy(refreshToken = "refresh-2"))
        assertEquals("refresh-2", vault.load()?.refreshToken)
        assertEquals(listOf("loom-credentials.v1"), folder.root.list()!!.toList())
    }

    @Test
    fun aKeyStoreThatDoesNotAnswerLeavesTheRecordExactlyAsItWas() = runBlocking {
        vault.save(saved)
        val bytes = record.readBytes()
        keystore.unavailable = true

        assertThrows(VaultUnavailableException::class.java) { runBlocking { vault.load() } }
        assertArrayEquals("an outage is not evidence that the record is bad", bytes, record.readBytes())
        assertEquals(0, keystore.destroyed)

        keystore.unavailable = false
        assertEquals(saved, vault.load())
    }

    @Test
    fun aTamperedRecordIsRemovedAndReportedAsNoSignIn() = runBlocking {
        vault.save(saved)
        val bytes = record.readBytes()
        bytes[3] = (bytes[3].toInt() xor 1).toByte()
        record.writeBytes(bytes)
        assertNull(vault.load())
        assertFalse(record.exists())
        assertEquals(1, keystore.destroyed)
    }

    @Test
    fun aRecordWhoseKeyIsGoneForGoodIsRemoved() = runBlocking {
        vault.save(saved)
        keystore.keyExists = false
        assertNull(vault.load())
        assertFalse(record.exists())
    }

    @Test
    fun authenticBytesThatAreNotAValidRecordAreRemoved() = runBlocking {
        for (content in listOf(
            "not json",
            """{"version":2,"host":"loom.example.com","domain":"example.com","email":"d@example.com","refreshToken":"r"}""",
            """{"version":1,"host":"evil host","domain":"example.com","email":"d@example.com","refreshToken":"r"}""",
            """{"version":1,"host":"loom.example.com","domain":"example.com","email":"d@example.com","refreshToken":""}""",
        )) {
            record.writeBytes(keystore.seal(content.toByteArray()))
            assertNull(content, vault.load())
            assertFalse(record.exists())
        }
    }

    @Test
    fun aFailedSaveKeepsThePreviousRecord() = runBlocking {
        vault.save(saved)
        keystore.unavailable = true
        assertThrows(VaultUnavailableException::class.java) {
            runBlocking { vault.save(saved.copy(refreshToken = "refresh-2")) }
        }
        keystore.unavailable = false
        assertEquals(saved, vault.load())
        assertEquals(listOf("loom-credentials.v1"), folder.root.list()!!.toList())
    }

    @Test
    fun clearRemovesTheRecordAndItsKey() = runBlocking {
        vault.save(saved)
        vault.clear()
        assertFalse(record.exists())
        assertTrue(keystore.destroyed == 1)
        assertNull(vault.load())
        vault.clear() // Nothing to remove is not an error.
    }
}
