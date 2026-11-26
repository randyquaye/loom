package dev.loom.app.android.auth

import dev.loom.app.android.core.asObject
import dev.loom.app.android.core.number
import dev.loom.app.android.core.string
import dev.loom.app.android.net.NetworkException
import dev.loom.app.android.runner.NoCredentialsException
import dev.loom.app.android.trust.Trust
import dev.loom.app.android.trust.TrustException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.security.SecureRandom

sealed interface AuthState {
    data object Restoring : AuthState
    data class StorageUnavailable(val message: String) : AuthState
    data class SignedOut(val notice: String? = null) : AuthState
    data class SigningIn(val host: String, val step: String, val awaitingBrowser: Boolean) : AuthState

    /** [session] numbers the sign-in, so two sign-ins never compare equal, even to one account. */
    data class SignedIn(val host: String, val email: String, val session: Long) : AuthState
}

/** What the UI may ask of authentication. Implemented for real, and by the DEBUG preview. */
interface AuthPort {
    val state: StateFlow<AuthState>

    /** Validates input and returns the `/auth/start` URL to open in the browser's Auth Tab. */
    suspend fun begin(originText: String, emailText: String): Result<String>
    suspend fun cancelSignIn()

    /** What the Auth Tab returned. Anything but this attempt's own redirect ends the attempt. */
    suspend fun complete(rawCallback: String?)
    suspend fun signOut()
    suspend fun retryStorage() = Unit

    /** The host refused [ended] for good. A sign-in that has since replaced it is left alone. */
    suspend fun endSession(ended: AuthState.SignedIn, notice: String)
}

/** The runner turned the code or token down with an OAuth error; retrying will not help. */
class SignInRefusedException(message: String) : Exception(message)

/** One consistent view of who is connecting: the token with the host it was issued for. */
class Access(val origin: Origin, val domain: String, val token: String)

private class AccessToken(val value: String, val expiresAtMs: Long)

/** What the host answered to a code or refresh token: the next refresh token and its access. */
private class Rotation(val refreshToken: String, val access: AccessToken)

/**
 * The single owner of credentials: what is in memory, what is on disk and what the screen is
 * told all change here and nowhere else.
 *
 * Every change is a transaction under one [gate]. A transaction reads the current [identity],
 * writes the vault and only then publishes, so whenever the gate is free the saved record and
 * the published state agree. Network requests never hold the gate. They belong to the identity
 * that started them, as children of its job: ending an identity cancels its requests, and an
 * answer that arrives anyway is applied only if that same identity is still the current one.
 */
class AuthManager(
    private val vault: CredentialVault,
    private val network: AuthNetwork,
    scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
    private val random: SecureRandom = SecureRandom(),
) : AuthPort {
    private val published = MutableStateFlow<AuthState>(AuthState.Restoring)
    override val state: StateFlow<AuthState> = published.asStateFlow()

    private val jobs = SupervisorJob(scope.coroutineContext[Job])
    private val scope = CoroutineScope(scope.coroutineContext + jobs)

    private sealed class Identity(parent: CoroutineScope) {
        /** Parent of every request made on this identity's behalf. */
        val work = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]))
    }

    /** An erase must finish before another sign-in can replace the saved record. */
    private class Erasure(parent: CoroutineScope) : Identity(parent)

    private class Attempt(val browser: SignInAttempt, parent: CoroutineScope) : Identity(parent)

    private class Session(val number: Long, var credentials: StoredCredentials, parent: CoroutineScope) : Identity(parent) {
        var access: AccessToken? = null
        /** A rotation the host has made that is not on disk yet. Never used until it is. */
        var unsaved: Rotation? = null
        var renewal: Deferred<Access>? = null

        /** The refresh token the host currently honours. */
        val liveRefreshToken: String get() = unsaved?.refreshToken ?: credentials.refreshToken
    }

    private val gate = Mutex()

    // Read and written only while holding the gate.
    private var identity: Identity? = null
    private var sessions = 0L

    /** Transactions run to completion: a caller that goes away cannot leave one half applied. */
    private suspend fun <T> transaction(block: suspend () -> T): T =
        withContext(NonCancellable) { gate.withLock { block() } }

    /** In a transaction: the current identity is over. Its requests stop and its record goes. */
    private suspend fun end(next: AuthState.SignedOut) {
        val ended = identity
        identity = null
        ended?.work?.cancel()
        if (ended is Session || ended is Erasure) {
            try {
                vault.clear()
            } catch (_: Exception) {
                identity = Erasure(scope)
                published.value = AuthState.StorageUnavailable("Sign-out is incomplete because this device couldn't erase its saved sign-in. Try again before leaving Loom.")
                return
            }
        }
        published.value = next
    }

    /** In a transaction: [session] takes over from whatever came before it. */
    private fun install(session: Session) {
        identity?.work?.cancel()
        identity = session
        published.value = AuthState.SignedIn(session.credentials.host, session.credentials.email, session.number)
    }

    fun restore() {
        scope.launch {
            transaction {
                if (published.value != AuthState.Restoring && published.value !is AuthState.StorageUnavailable) return@transaction
                if (identity is Erasure) {
                    end(AuthState.SignedOut())
                    return@transaction
                }
                published.value = AuthState.Restoring
                val saved = try {
                    vault.load()
                } catch (_: VaultUnavailableException) {
                    // Nothing was read, so nothing is concluded about the record: it stays.
                    published.value = AuthState.StorageUnavailable(
                        "Loom couldn't open this device's secure storage. Unlock your device and try again."
                    )
                    return@transaction
                }
                if (saved == null) published.value = AuthState.SignedOut()
                else install(Session(++sessions, saved, scope))
            }
        }
    }

    override suspend fun retryStorage() = restore()

    // ---- Sign-in --------------------------------------------------------------------------

    override suspend fun begin(originText: String, emailText: String): Result<String> {
        val origin = SignInInputs.parseOrigin(originText)
            ?: return Result.failure(IllegalArgumentException("Enter your organization's address as https://host, with no path or port."))
        val email = SignInInputs.normalizeEmail(emailText)
            ?: return Result.failure(IllegalArgumentException("Enter your primary work email address."))
        return transaction {
            if (published.value !is AuthState.SignedOut && identity !is Attempt) {
                return@transaction Result.failure(IllegalStateException("Loom is already signed in or still opening."))
            }
            identity?.work?.cancel() // An unfinished attempt is replaced, never resumed.
            val pending = PendingSignIn.create(origin, email, clock(), random)
            identity = Attempt(SignInAttempt(pending), scope)
            published.value = AuthState.SigningIn(origin.host, "Continue in your browser", awaitingBrowser = true)
            Result.success(pending.startUrl())
        }
    }

    override suspend fun cancelSignIn() = transaction {
        if (identity is Attempt) end(AuthState.SignedOut())
    }

    override suspend fun complete(rawCallback: String?) = transaction {
        val attempt = identity as? Attempt ?: return@transaction
        when (val outcome = attempt.browser.receive(rawCallback, clock())) {
            is CallbackOutcome.Code -> {
                published.value = AuthState.SigningIn(attempt.browser.pending.origin.host, "Verifying your organization…", awaitingBrowser = false)
                attempt.work.launch { exchange(attempt, outcome.code) }
            }
            CallbackOutcome.Expired -> end(AuthState.SignedOut("Signing in took too long. Try again."))
            CallbackOutcome.Refused -> end(
                AuthState.SignedOut("This account can't sign in to that organization. Use the primary work email of an existing member.")
            )
            // The tab has closed, so nothing else is coming for this attempt.
            is CallbackOutcome.Ignored -> if (!attempt.browser.finished) {
                end(AuthState.SignedOut("The browser didn't finish signing in. Try again."))
            }
        }
    }

    /** The verifier is sent only after the Google identity, DNS and host proofs all pass. */
    private suspend fun exchange(attempt: Attempt, code: String) {
        val pending = attempt.browser.pending
        val origin = pending.origin
        try {
            val reply = network.proof(origin, mapOf("code" to code, "redirect_uri" to OAuthCallback.REDIRECT_URI))
            if (reply.status !in 200..299) throw SignInRefusedException("The host refused this sign-in.")
            val body = reply.json.asObject() ?: throw TrustException("The host returned an invalid sign-in proof.")
            val idToken = body.string("id_token") ?: throw TrustException("The host returned no identity proof.")
            val verified = Trust.verifyGoogleIdentity(idToken, network.googleKeys(), pending.nonce, pending.email, clock())
            Trust.verifyHostBinding(verified.domain, origin.host, pending.nonce, body["host_proof"], network.dnsTxt(verified.domain))

            transaction {
                if (identity === attempt) {
                    published.value = AuthState.SigningIn(origin.host, "Securing the connection…", awaitingBrowser = false)
                }
            }
            val granted = requestTokens(
                origin, verified.domain,
                mapOf(
                    "grant_type" to "authorization_code",
                    "code" to code,
                    "redirect_uri" to OAuthCallback.REDIRECT_URI,
                    "code_verifier" to pending.verifier,
                ),
            )
            transaction {
                if (identity !== attempt) return@transaction // Cancelled meanwhile: nothing is kept.
                val saved = StoredCredentials(origin.host, verified.domain, verified.email, granted.refreshToken)
                vault.save(saved)
                install(Session(++sessions, saved, scope).also { it.access = granted.access })
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            transaction { if (identity === attempt) end(AuthState.SignedOut(signInMessage(error))) }
        }
    }

    private fun signInMessage(error: Exception): String = when (error) {
        is TrustException -> error.message ?: "The organization's host could not be verified."
        is SignInRefusedException -> "Sign-in was refused: ${error.message}"
        is NetworkException -> "Couldn't reach the verification services. Check your connection and try again."
        is VaultUnavailableException -> "Loom couldn't save the sign-in to this device's secure storage. Try again."
        else -> "Signing in failed. Try again."
    }

    private suspend fun requestTokens(origin: Origin, domain: String, fields: Map<String, String>): Rotation {
        val reply = network.pinnedPost(origin, domain, "/auth/token", fields)
        val body = reply.json.asObject() ?: emptyMap()
        if (reply.status in setOf(400, 401) && body["error"] is String) {
            throw SignInRefusedException(body.string("error_description") ?: "The host refused the sign-in.")
        }
        if (reply.status !in 200..299) throw NetworkException("The host could not be reached (${reply.status})")
        val accessToken = body.string("access_token")
        val refreshToken = body.string("refresh_token")
        val expiresIn = body.number("expires_in")
        if (accessToken.isNullOrEmpty() || refreshToken.isNullOrEmpty() || expiresIn == null || expiresIn <= 0) {
            throw NetworkException("The host returned an incomplete sign-in")
        }
        val expiresAt = clock() + (expiresIn.coerceAtMost(24 * 3600.0) * 1000).toLong()
        return Rotation(refreshToken, AccessToken(accessToken, expiresAt))
    }

    // ---- Access tokens --------------------------------------------------------------------

    /**
     * A usable access token with the host it belongs to. Everyone asking while a renewal is
     * under way shares it. [renew] is for a caller whose last token the host turned away.
     */
    suspend fun access(renew: Boolean = false): Access {
        val pending = transaction {
            val session = identity as? Session ?: throw NoCredentialsException()
            session.renewal?.let { return@transaction it }
            val cached = session.access
            if (!renew && cached != null && cached.expiresAtMs - 60_000 > clock()) {
                return@transaction CompletableDeferred(session.grant(cached))
            }
            val from = session.credentials
            val unsaved = session.unsaved
            session.work.async { rotate(session, from, unsaved) }.also { session.renewal = it }
        }
        return try {
            pending.await()
        } catch (cancelled: CancellationException) {
            currentCoroutineContext().ensureActive()
            throw NoCredentialsException() // Not this caller: the sign-in ended mid-renewal.
        }
    }

    private fun Session.grant(token: AccessToken) = Access(credentials.origin, credentials.domain, token.value)

    private suspend fun rotate(session: Session, from: StoredCredentials, unsaved: Rotation?): Access {
        try {
            val rotation = unsaved ?: try {
                requestTokens(
                    from.origin, from.domain,
                    mapOf("grant_type" to "refresh_token", "refresh_token" to from.refreshToken),
                )
            } catch (refused: SignInRefusedException) {
                transaction {
                    if (identity === session) end(AuthState.SignedOut("Your sign-in ended. Sign in again to continue."))
                }
                throw NoCredentialsException()
            }
            // A network or proof failure propagates and keeps the sign-in for a later try.
            return transaction {
                if (identity !== session) throw NoCredentialsException()
                // The host has rotated and will refuse the old token from now on. Hold its
                // answer first, so a failed write is retried rather than the old token replayed.
                session.unsaved = rotation
                vault.save(from.copy(refreshToken = rotation.refreshToken))
                session.credentials = from.copy(refreshToken = rotation.refreshToken)
                session.unsaved = null
                session.access = rotation.access
                session.grant(rotation.access)
            }
        } finally {
            transaction { session.renewal = null }
        }
    }

    // ---- Sign-out -------------------------------------------------------------------------

    override suspend fun signOut() {
        val ended = transaction {
            val session = identity as? Session
            val live = session?.let { it.credentials.copy(refreshToken = it.liveRefreshToken) }
            if (identity != null) end(AuthState.SignedOut())
            live
        } ?: return
        scope.launch {
            // Best effort over a freshly pinned connection; the token also expires by itself.
            try {
                network.pinnedPost(ended.origin, ended.domain, "/auth/revoke", mapOf("token" to ended.refreshToken))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
            }
        }
    }

    override suspend fun endSession(ended: AuthState.SignedIn, notice: String) = transaction {
        if ((identity as? Session)?.number == ended.session) end(AuthState.SignedOut(notice))
    }
}
