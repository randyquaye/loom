package dev.loom.app.android.auth

/** The one durable record: host, independently verified trust domain, email and refresh token. */
data class StoredCredentials(
    val host: String,
    val domain: String,
    val email: String,
    val refreshToken: String,
) {
    val origin: Origin get() = Origin(host)
    override fun toString(): String = "StoredCredentials(host=$host, domain=$domain)"
}

/**
 * The device's secure storage cannot be used right now. Whatever is saved is still there and
 * has not been read: this is neither "nothing saved" nor "the record is damaged".
 */
class VaultUnavailableException(cause: Throwable? = null) :
    Exception("This device's secure storage is unavailable", cause)

/** Durable storage for the single credential record. Only [AuthManager] calls it. */
interface CredentialVault {
    /**
     * The saved record, or null when there is none. A record that can never be read again
     * (damaged, or sealed under a key that no longer exists) is removed and reported as null.
     * Throws [VaultUnavailableException], leaving the record alone, when storage is unusable.
     */
    suspend fun load(): StoredCredentials?

    /** Durably replaces the record, or throws and leaves the previous record in place. */
    suspend fun save(credentials: StoredCredentials)

    /** Removes the record, or throws if it is still there. */
    suspend fun clear()
}
