package dev.loom.app.android.auth

import dev.loom.app.android.net.HttpReply
import dev.loom.app.android.net.NetworkException
import dev.loom.app.android.runner.NoCredentialsException
import dev.loom.app.android.trust.TestSigners
import dev.loom.app.android.trust.Trust
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.URI
import java.net.URLDecoder

/**
 * The credential boundary under adversarial timing: a vault and a host whose every reply the
 * test holds back or fails, driving the real manager, callback checks and proof verification.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AuthManagerTest {
    private val host = "loom.example.com"
    private val domain = "example.com"
    private val email = "dev@example.com"
    private var now = 1_800_000_000_000L
    private val rsa = TestSigners.Rsa()
    private val ed = TestSigners.Ed()

    private class FakeVault : CredentialVault {
        var record: StoredCredentials? = null
        var saveGate: CompletableDeferred<Unit>? = null
        var clearGate: CompletableDeferred<Unit>? = null
        var saveFailure: Exception? = null
        var loadFailure: Exception? = null
        var clearFailure: Exception? = null
        var saves = 0
        var clears = 0

        override suspend fun load(): StoredCredentials? {
            loadFailure?.let { throw it }
            return record
        }

        /** Like an atomic file replace: nothing is visible until the write completes. */
        override suspend fun save(credentials: StoredCredentials) {
            saveGate?.await()
            saveFailure?.let { throw it }
            record = credentials
            saves++
        }

        override suspend fun clear() {
            clearGate?.await()
            clearFailure?.let { throw it }
            record = null
            clears++
        }
    }

    /** A host that rotates refresh tokens and, like the runner, refuses one it already rotated. */
    private inner class FakeHost : AuthNetwork {
        var nonce = ""
        var challenge = ""
        var signer = ed
        var tokenGate: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        val tokenCalls = ArrayList<Map<String, String>>()
        val revoked = ArrayList<String>()
        private var issued = 0
        private var liveRefresh: String? = null

        val refreshCalls get() = tokenCalls.count { it["grant_type"] == "refresh_token" }

        override suspend fun proof(origin: Origin, fields: Map<String, String>): HttpReply {
            assertFalse("the verifier must never reach the unpinned proof endpoint", fields.containsKey("code_verifier"))
            val claims = mapOf(
                "iss" to "accounts.google.com", "sub" to "subject-1", "email" to email, "email_verified" to true,
                "hd" to domain, "nonce" to nonce, "iat" to now / 1000 - 5, "exp" to now / 1000 + 600,
            )
            val proof = mapOf(
                "host" to host,
                "public_key" to signer.spkiBase64,
                "signature" to signer.sign(Trust.hostProofPayload(host, nonce)),
            )
            return HttpReply(200, mapOf("id_token" to rsa.jwt(claims), "host_proof" to proof))
        }

        override suspend fun googleKeys(): Any? = rsa.jwks()

        override suspend fun dnsTxt(domain: String): Any? = TestSigners.dns(domain, host, ed.fingerprint)

        override suspend fun pinnedPost(origin: Origin, domain: String, path: String, fields: Map<String, String>): HttpReply {
            assertEquals(host, origin.host)
            assertEquals(this@AuthManagerTest.domain, domain)
            if (path == "/auth/revoke") {
                revoked += fields.getValue("token")
                return HttpReply(200, null)
            }
            assertEquals("/auth/token", path)
            tokenCalls += fields
            tokenGate?.await()
            failure?.let { throw it }
            val accepted = when (fields["grant_type"]) {
                "authorization_code" -> Pkce.challenge(fields.getValue("code_verifier")) == challenge
                else -> fields["refresh_token"] == liveRefresh
            }
            if (!accepted) return HttpReply(400, mapOf("error" to "invalid_grant", "error_description" to "revoked"))
            val n = ++issued
            liveRefresh = "refresh-$n"
            return HttpReply(200, mapOf("access_token" to "access-$n", "refresh_token" to "refresh-$n", "expires_in" to 900L))
        }

        fun revokeEverything() {
            liveRefresh = null
        }
    }

    private val vault = FakeVault()
    private val network = FakeHost()

    /** The manager's own scope on the test scheduler, so its work counts as work to wait for. */
    private fun TestScope.manager(): AuthManager =
        AuthManager(vault, network, CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler)), clock = { now }).also {
            it.restore()
            runCurrent()
        }

    /** What the browser would do: follow the start URL and come back with the code. */
    private suspend fun callbackFor(auth: AuthManager): String {
        val url = auth.begin("https://$host", email).getOrThrow()
        val query = URI(url).rawQuery.split('&').associate {
            it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8")
        }
        network.nonce = query.getValue("nonce")
        network.challenge = query.getValue("code_challenge")
        return "${OAuthCallback.REDIRECT_URI}?code=code-1&state=${query.getValue("state")}"
    }

    private suspend fun TestScope.signIn(auth: AuthManager) {
        auth.complete(callbackFor(auth))
        advanceUntilIdle()
        assertTrue("signed in, was ${auth.state.value}", auth.state.value is AuthState.SignedIn)
    }

    private fun expireAccess() {
        now += 3_600_000
    }

    private suspend fun tokenOrError(auth: AuthManager): Result<String> = try {
        Result.success(auth.access().token)
    } catch (error: Exception) {
        Result.failure(error)
    }

    // ---- Sign-in ---------------------------------------------------------------------------

    @Test
    fun signInSendsTheVerifierOnlyOverThePinnedExchangeAndSavesBeforePublishing() = runTest {
        val auth = manager()
        assertEquals(AuthState.SignedOut(), auth.state.value)
        signIn(auth)
        assertEquals(StoredCredentials(host, domain, email, "refresh-1"), vault.record)
        assertEquals("authorization_code", network.tokenCalls.single()["grant_type"])
        assertEquals("access-1", auth.access().token)
        assertEquals(1, network.tokenCalls.size)
    }

    @Test
    fun verifierIsWithheldWhenTheHostCannotProveTheDnsListedKey() = runTest {
        val auth = manager()
        network.signer = TestSigners.Ed()
        auth.complete(callbackFor(auth))
        advanceUntilIdle()
        assertNotNull((auth.state.value as AuthState.SignedOut).notice)
        assertTrue(network.tokenCalls.isEmpty())
        assertNull(vault.record)
    }

    @Test
    fun cancelledExchangeNeverPersists() = runTest {
        val auth = manager()
        network.tokenGate = CompletableDeferred()
        val callback = callbackFor(auth)
        launch { auth.complete(callback) }
        runCurrent()
        assertEquals(1, network.tokenCalls.size) // The code exchange is in flight.

        auth.cancelSignIn()
        runCurrent()
        network.tokenGate!!.complete(Unit)
        advanceUntilIdle()

        assertEquals(AuthState.SignedOut(), auth.state.value)
        assertNull("a cancelled sign-in must leave nothing for a cold start to restore", vault.record)
        assertEquals(0, vault.saves)
    }

    @Test
    fun cancelRacingTheFinalSaveEndsWithDiskAndScreenAgreeing() = runTest {
        val auth = manager()
        vault.saveGate = CompletableDeferred()
        val callback = callbackFor(auth)
        launch { auth.complete(callback) }
        runCurrent() // Suspended inside the save.
        launch { auth.cancelSignIn() }
        runCurrent()
        vault.saveGate!!.complete(Unit)
        advanceUntilIdle()

        assertEquals(auth.state.value is AuthState.SignedIn, vault.record != null)
        assertEquals(auth.state.value is AuthState.SignedIn, tokenOrError(auth).isSuccess)
    }

    @Test
    fun aReturnThatIsNotThisAttemptsRedirectEndsItWithoutContactingTheHost() = runTest {
        val auth = manager()
        val genuine = callbackFor(auth)
        auth.complete(genuine.substringBefore("state=") + "state=" + "A".repeat(43))
        advanceUntilIdle()
        assertNotNull((auth.state.value as AuthState.SignedOut).notice)
        // The attempt is over: its real callback, replayed later, signs nobody in.
        auth.complete(genuine)
        advanceUntilIdle()
        assertTrue(auth.state.value is AuthState.SignedOut)
        assertTrue(network.tokenCalls.isEmpty())
        assertNull(vault.record)
    }

    // ---- Rotation --------------------------------------------------------------------------

    @Test
    fun concurrentTokenRequestsRotateOnce() = runTest {
        val auth = manager()
        signIn(auth)
        expireAccess()
        network.tokenGate = CompletableDeferred()
        val asked = List(8) { async { auth.access().token } }
        runCurrent()
        assertEquals(1, network.refreshCalls)
        network.tokenGate!!.complete(Unit)
        assertEquals(List(8) { "access-2" }, asked.awaitAll())
        assertEquals(1, network.refreshCalls)
        assertEquals("refresh-2", vault.record?.refreshToken)
    }

    @Test
    fun failedRotationSaveNeverPublishesUsableAccessAndIsNotReplayed() = runTest {
        val auth = manager()
        signIn(auth)
        expireAccess()
        vault.saveFailure = IOException("disk full")

        val first = tokenOrError(auth)
        assertTrue("no access token may be used before its refresh token is saved", first.isFailure)
        assertFalse(first.exceptionOrNull() is NoCredentialsException)
        assertTrue(auth.state.value is AuthState.SignedIn)
        assertEquals("refresh-1", vault.record?.refreshToken)

        // Storage recovers. The rotation the host already made is saved, not requested again:
        // replaying the consumed refresh token would revoke the whole sign-in.
        vault.saveFailure = null
        assertEquals("access-2", auth.access().token)
        assertEquals(1, network.refreshCalls)
        assertEquals("refresh-2", vault.record?.refreshToken)
        assertTrue(auth.state.value is AuthState.SignedIn)
    }

    @Test
    fun renewRotatesEvenWhileTheCachedTokenLooksValid() = runTest {
        val auth = manager()
        signIn(auth)
        assertEquals("access-1", auth.access().token)
        assertEquals("access-2", auth.access(renew = true).token)
        assertEquals("refresh-2", vault.record?.refreshToken)
    }

    @Test
    fun networkFailureDuringRefreshKeepsTheSignIn() = runTest {
        val auth = manager()
        signIn(auth)
        expireAccess()
        network.failure = NetworkException("offline")
        assertTrue(tokenOrError(auth).exceptionOrNull() is NetworkException)
        assertTrue(auth.state.value is AuthState.SignedIn)
        assertEquals("refresh-1", vault.record?.refreshToken)
        network.failure = null
        assertEquals("access-2", auth.access().token)
    }

    @Test
    fun refusedRefreshEndsTheSignInAndErasesIt() = runTest {
        val auth = manager()
        signIn(auth)
        expireAccess()
        network.revokeEverything()
        assertTrue(tokenOrError(auth).exceptionOrNull() is NoCredentialsException)
        advanceUntilIdle()
        assertNotNull((auth.state.value as AuthState.SignedOut).notice)
        assertNull(vault.record)
    }

    // ---- Sign-out --------------------------------------------------------------------------

    @Test
    fun signOutWhileARotationIsBeingSavedCannotRestoreCredentials() = runTest {
        val auth = manager()
        signIn(auth)
        expireAccess()
        vault.saveGate = CompletableDeferred()
        val asked = async { tokenOrError(auth) }
        runCurrent() // The rotated token is mid-write.
        launch { auth.signOut() }
        runCurrent()
        vault.saveGate!!.complete(Unit)
        advanceUntilIdle()
        asked.await()

        assertEquals(AuthState.SignedOut(), auth.state.value)
        assertNull("a save finishing after sign-out must not bring the sign-in back", vault.record)
        assertTrue(tokenOrError(auth).exceptionOrNull() is NoCredentialsException)
        // The host is told to end the token it currently honours, not one already rotated away.
        assertEquals(listOf("refresh-2"), network.revoked)
    }

    @Test
    fun signOutDuringARefreshRequestDiscardsTheLateRotation() = runTest {
        val auth = manager()
        signIn(auth)
        expireAccess()
        network.tokenGate = CompletableDeferred()
        val asked = async { tokenOrError(auth) }
        runCurrent()
        launch { auth.signOut() }
        runCurrent()
        assertEquals(AuthState.SignedOut(), auth.state.value)
        network.tokenGate!!.complete(Unit)
        advanceUntilIdle()

        assertTrue(asked.await().exceptionOrNull() is NoCredentialsException)
        assertNull(vault.record)
        assertEquals(1, vault.saves) // Only the original sign-in was ever written.
        assertEquals(AuthState.SignedOut(), auth.state.value)
    }

    @Test
    fun cleanupOfAnEndedSignInCannotEraseTheNextOne() = runTest {
        val auth = manager()
        signIn(auth)
        vault.clearGate = CompletableDeferred() // The old record's deletion is slow.
        launch { auth.signOut() }
        runCurrent()
        launch { auth.complete(callbackFor(auth)) }
        runCurrent()
        vault.clearGate!!.complete(Unit)
        advanceUntilIdle()

        assertTrue(auth.state.value is AuthState.SignedIn)
        assertEquals("the new sign-in must survive the old one's cleanup", "refresh-2", vault.record?.refreshToken)
        assertEquals("access-2", auth.access().token)
    }

    @Test
    fun aRefusalMeantForAnEndedSignInCannotEndItsSuccessor() = runTest {
        val auth = manager()
        signIn(auth)
        val first = auth.state.value as AuthState.SignedIn
        auth.signOut()
        signIn(auth)
        val second = auth.state.value as AuthState.SignedIn
        assertFalse("each sign-in is its own identity, even for one account", first == second)

        auth.endSession(first, "late refusal")
        assertEquals(second, auth.state.value)
        assertEquals("refresh-2", vault.record?.refreshToken)

        auth.endSession(second, "refused")
        assertEquals(AuthState.SignedOut("refused"), auth.state.value)
        assertNull(vault.record)
    }

    // ---- Restore ---------------------------------------------------------------------------

    @Test
    fun restoreResumesASavedSignInByRotatingItsToken() = runTest {
        val first = manager()
        signIn(first)
        val restarted = manager()
        assertTrue(restarted.state.value is AuthState.SignedIn)
        assertEquals("access-2", restarted.access().token)
        assertEquals("refresh-2", vault.record?.refreshToken)
    }

    @Test
    fun unavailableSecureStorageIsNeitherSignedInNorErased() = runTest {
        val saved = StoredCredentials(host, domain, email, "refresh-kept")
        vault.record = saved
        vault.loadFailure = VaultUnavailableException()
        val auth = manager()
        assertFalse("unavailable storage must not look like a missing sign-in", auth.state.value is AuthState.SignedOut)
        assertTrue(auth.begin("https://$host", email).isFailure)
        assertEquals(saved, vault.record)
        assertEquals(0, vault.clears)

        // Once storage answers again, the untouched record is the sign-in it always was.
        vault.loadFailure = null
        auth.restore()
        runCurrent()
        assertTrue(auth.state.value is AuthState.SignedIn)
    }
    @Test
    fun aFailedEraseIsIncompleteSignOutAndRetriesBeforeAnotherSignIn() = runTest {
        val auth = manager()
        signIn(auth)
        vault.clearFailure = IOException("device storage unavailable")
        auth.signOut()
        advanceUntilIdle()
        assertNotNull(vault.record)
        assertFalse("never claim completed sign-out when its credential remains", auth.state.value is AuthState.SignedOut)
        assertTrue(auth.begin("https://$host", email).isFailure)
        assertTrue(runCatching { auth.access() }.exceptionOrNull() is NoCredentialsException)
        vault.clearFailure = null
        auth.restore()
        advanceUntilIdle()
        assertEquals(AuthState.SignedOut(), auth.state.value)
        assertNull(vault.record)
        signIn(auth)
    }

}
