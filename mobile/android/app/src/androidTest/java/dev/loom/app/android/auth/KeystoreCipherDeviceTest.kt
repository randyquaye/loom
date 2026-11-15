package dev.loom.app.android.auth

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The real Android Keystore, under a test-only alias so a device's actual sign-in is never
 * touched. Run with `./gradlew connectedDebugAndroidTest`.
 */
@RunWith(AndroidJUnit4::class)
class KeystoreCipherDeviceTest {
    private val cipher = KeystoreCipher(alias = "loom.credentials.device-test")
    private val secret = """{"refreshToken":"device-test-refresh-token"}""".toByteArray()

    @After
    fun tearDown() = cipher.destroy()

    @Test
    fun sealsWithAFreshNonceAndOpensWhatItSealed() {
        val first = cipher.seal(secret)
        val second = cipher.seal(secret)
        assertFalse(first.contentEquals(second))
        assertFalse(String(first, Charsets.ISO_8859_1).contains("device-test-refresh-token"))
        assertArrayEquals(secret, cipher.open(first))
        assertArrayEquals(secret, cipher.open(second))
    }

    @Test
    fun anyAlteredByteIsUnreadableNotUnavailable() {
        val sealed = cipher.seal(secret)
        for (index in listOf(0, 1, 12, 13, sealed.size / 2, sealed.size - 1)) {
            val altered = sealed.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
            assertThrows("byte $index", UnreadableRecordException::class.java) { cipher.open(altered) }
        }
        assertThrows(UnreadableRecordException::class.java) { cipher.open(sealed.copyOf(20)) }
        assertThrows(UnreadableRecordException::class.java) { cipher.open(ByteArray(0)) }
        assertArrayEquals(secret, cipher.open(sealed))
    }

    @Test
    fun aRecordWhoseKeyWasDeletedIsUnreadableAndANewKeyIsMadeOnTheNextSeal() {
        val sealed = cipher.seal(secret)
        cipher.destroy()
        assertThrows(UnreadableRecordException::class.java) { cipher.open(sealed) }
        // The old ciphertext stays unreadable under the replacement key.
        val again = cipher.seal(secret)
        assertThrows(UnreadableRecordException::class.java) { cipher.open(sealed) }
        assertArrayEquals(secret, cipher.open(again))
    }

    @Test
    fun theVaultRoundTripsThroughTheRealKeystoreAndFileSystem() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir, "vault-device-test").apply { deleteRecursively(); mkdirs() }
        try {
            val vault = FileCredentialVault(directory, cipher)
            val saved = StoredCredentials("loom.example.com", "example.com", "dev@example.com", "refresh/1+x=")
            assertNull(vault.load())
            vault.save(saved)
            assertEquals(saved, FileCredentialVault(directory, cipher).load())
            vault.save(saved.copy(refreshToken = "refresh-2"))
            assertEquals("refresh-2", vault.load()?.refreshToken)
            assertEquals(listOf("loom-credentials.v1"), directory.list()!!.toList())

            val record = File(directory, "loom-credentials.v1")
            record.writeBytes(record.readBytes().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() })
            assertNull(vault.load())
            assertFalse(record.exists())
        } finally {
            directory.deleteRecursively()
        }
    }
}
