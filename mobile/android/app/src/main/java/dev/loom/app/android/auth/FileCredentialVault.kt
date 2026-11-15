package dev.loom.app.android.auth

import dev.loom.app.android.core.Json
import dev.loom.app.android.core.asObject
import dev.loom.app.android.core.long
import dev.loom.app.android.core.string
import dev.loom.app.android.trust.Trust
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Arrays

/** These bytes can never be opened again: they are damaged, or their key no longer exists. */
class UnreadableRecordException : Exception("The saved record cannot be read")

/** Seals the record under a key that never leaves the device. */
interface RecordCipher {
    /** Throws [VaultUnavailableException] when the key store cannot be used right now. */
    fun seal(plain: ByteArray): ByteArray

    /**
     * Throws [UnreadableRecordException] only when no later attempt could succeed, and
     * [VaultUnavailableException] for every failure that says nothing about the record itself.
     */
    fun open(sealed: ByteArray): ByteArray

    /** Forgets the key, as far as the device allows. */
    fun destroy()
}

/**
 * The record as one sealed file in no-backup storage, replaced atomically. It is erased in
 * exactly two cases: on request, and when it has been proven unreadable for good. A key store
 * that fails to answer proves nothing, so the file stays for the next launch.
 *
 * Calls are not synchronized here: [AuthManager] is the only caller and serializes them.
 */
class FileCredentialVault(
    directory: File,
    private val cipher: RecordCipher,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : CredentialVault {
    private val file = File(directory, "loom-credentials.v1")
    private val temporary = File(directory, "loom-credentials.v1.tmp")

    override suspend fun load(): StoredCredentials? = withContext(io) {
        val sealed = try {
            if (!file.exists()) return@withContext null
            file.readBytes()
        } catch (error: IOException) {
            throw VaultUnavailableException(error)
        }
        try {
            decode(cipher.open(sealed))
        } catch (_: UnreadableRecordException) {
            erase()
            null
        }
    }

    override suspend fun save(credentials: StoredCredentials) = withContext(io) {
        val plain = encode(credentials)
        try {
            val sealed = cipher.seal(plain)
            temporary.outputStream().use { out ->
                out.write(sealed)
                out.fd.sync()
            }
            Files.move(
                temporary.toPath(), file.toPath(),
                StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING,
            )
            Unit
        } finally {
            Arrays.fill(plain, 0)
            temporary.delete()
        }
    }

    override suspend fun clear() = withContext(io) { erase() }

    private fun erase() {
        Files.deleteIfExists(file.toPath())
        Files.deleteIfExists(temporary.toPath())
        cipher.destroy()
    }

    private fun encode(credentials: StoredCredentials): ByteArray = Json.encode(
        mapOf(
            "version" to 1L,
            "host" to credentials.host,
            "domain" to credentials.domain,
            "email" to credentials.email,
            "refreshToken" to credentials.refreshToken,
        )
    ).toByteArray(Charsets.UTF_8)

    /** Authentic bytes that still are not a record this version wrote are unreadable too. */
    private fun decode(plain: ByteArray): StoredCredentials {
        val record = try {
            Json.parse(String(plain, Charsets.UTF_8)).asObject()
        } catch (_: Json.JsonException) {
            null
        } finally {
            Arrays.fill(plain, 0)
        } ?: throw UnreadableRecordException()
        val host = record.string("host")
        val domain = record.string("domain")
        val email = record.string("email")
        val refresh = record.string("refreshToken")
        if (record.long("version") != 1L || host == null || domain == null || email == null ||
            refresh.isNullOrEmpty() || !Trust.DOMAIN.matches(host) || !Trust.DOMAIN.matches(domain)
        ) {
            throw UnreadableRecordException()
        }
        return StoredCredentials(host, domain, email, refresh)
    }
}
