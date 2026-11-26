package dev.loom.app.android.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM under a non-exportable Android Keystore key (StrongBox when the device has
 * one). Sealed bytes are `version ‖ IV ‖ ciphertext+tag`. Nothing here is logged.
 *
 * Only three outcomes mean the record is gone for good: the bytes are not in this format, the
 * key store reports that no such key exists (or that it is permanently invalidated), or the
 * authentication tag does not verify. Any other failure is the key store being unavailable.
 */
class KeystoreCipher(private val alias: String = "loom.credentials.v1") : RecordCipher {
    override fun seal(plain: ByteArray): ByteArray = available {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, usableKey() ?: createKey())
        cipher.updateAAD(AAD)
        val sealed = cipher.doFinal(plain)
        val iv = cipher.iv
        check(iv.size == IV_BYTES)
        byteArrayOf(VERSION) + iv + sealed
    }

    override fun open(sealed: ByteArray): ByteArray {
        if (sealed.size < 1 + IV_BYTES + TAG_BYTES || sealed[0] != VERSION) throw UnreadableRecordException()
        return available {
            try {
                val key = keyStore().getKey(alias, null) as? SecretKey ?: throw UnreadableRecordException()
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BYTES * 8, sealed, 1, IV_BYTES))
                cipher.updateAAD(AAD)
                cipher.doFinal(sealed, 1 + IV_BYTES, sealed.size - 1 - IV_BYTES)
            } catch (_: AEADBadTagException) {
                throw UnreadableRecordException()
            } catch (_: KeyPermanentlyInvalidatedException) {
                throw UnreadableRecordException()
            }
        }
    }

    override fun destroy() {
        try {
            keyStore().deleteEntry(alias)
        } catch (_: Exception) {
            // The record file is already gone; a key with nothing sealed under it protects nothing.
        }
    }

    private inline fun <T> available(block: () -> T): T = try {
        block()
    } catch (error: GeneralSecurityException) {
        throw VaultUnavailableException(error)
    } catch (error: ProviderException) {
        throw VaultUnavailableException(error)
    } catch (error: IOException) {
        throw VaultUnavailableException(error)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /** For sealing a replacement record, a key that can no longer be recovered is no key. */
    private fun usableKey(): SecretKey? = try {
        keyStore().getKey(alias, null) as? SecretKey
    } catch (_: UnrecoverableKeyException) {
        null
    }

    private fun createKey(): SecretKey {
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(
            alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setIsStrongBoxBacked(strongBox)
            .build()
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        return try {
            generator.init(spec(true))
            generator.generateKey()
        } catch (_: StrongBoxUnavailableException) {
            generator.init(spec(false))
            generator.generateKey()
        }
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BYTES = 16
        const val VERSION: Byte = 1
        val AAD = "loom.credentials.v1".toByteArray(Charsets.US_ASCII)
    }
}
