package dev.loom.app.android.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.security.SecureRandom

class SignInCallbackTest {
    private val origin = SignInInputs.parseOrigin("https://loom.example.com")!!
    private val start = 1_800_000_000_000L
    private fun attempt() = SignInAttempt(PendingSignIn.create(origin, "dev@example.com", start, SecureRandom()))

    private fun callback(attempt: SignInAttempt, query: String) = "dev.loom.app.android:/oauth/callback?$query"

    @Test
    fun redirectUriIsTheExactAllowlistedConstant() {
        assertEquals("dev.loom.app.android:/oauth/callback", OAuthCallback.REDIRECT_URI)
    }

    @Test
    fun acceptsExactCallbackWithMatchingStateOnce() {
        val a = attempt()
        val raw = callback(a, "code=loom_code_abcDEF123-_x&state=${a.pending.state}")
        val outcome = a.receive(raw, start + 1000)
        assertEquals(CallbackOutcome.Code("loom_code_abcDEF123-_x"), outcome)
        // A second delivery (replay, double tap, hostile app) never completes again.
        assertTrue(a.receive(raw, start + 2000) is CallbackOutcome.Ignored)
    }

    @Test
    fun parameterOrderDoesNotMatter() {
        val a = attempt()
        assertEquals(
            CallbackOutcome.Code("abc"),
            a.receive(callback(a, "state=${a.pending.state}&code=abc"), start + 1)
        )
    }

    @Test
    fun serverRefusalEndsTheAttempt() {
        val a = attempt()
        assertEquals(CallbackOutcome.Refused, a.receive(callback(a, "error=access_denied&state=${a.pending.state}"), start + 1))
        assertTrue(a.receive(callback(a, "code=abc&state=${a.pending.state}"), start + 2) is CallbackOutcome.Ignored)
    }

    @Test
    fun wrongStateIsIgnoredWithoutCancellingTheRealAttempt() {
        val a = attempt()
        assertTrue(a.receive(callback(a, "code=abc&state=forged"), start + 1) is CallbackOutcome.Ignored)
        assertEquals(CallbackOutcome.Code("abc"), a.receive(callback(a, "code=abc&state=${a.pending.state}"), start + 2))
    }

    @Test
    fun expiredAttemptIsRefused() {
        val a = attempt()
        assertEquals(
            CallbackOutcome.Expired,
            a.receive(callback(a, "code=abc&state=${a.pending.state}"), start + PendingSignIn.LIFETIME_MS + 1)
        )
    }

    @Test
    fun refusesNearMissUrisAndHostileParameters() {
        val a = attempt()
        val s = a.pending.state
        val hostile = listOf(
            "dev.loom.app.android://oauth/callback?code=abc&state=$s",
            "dev.loom.app.android:/oauth/callback/?code=abc&state=$s",
            "dev.loom.app.android:/oauth/Callback?code=abc&state=$s",
            "DEV.LOOM.APP.ANDROID:/oauth/callback?code=abc&state=$s",
            "dev.loom.app.ios:/oauth/callback?code=abc&state=$s",
            "dev.loom.app.android.evil:/oauth/callback?code=abc&state=$s",
            "dev.loom.app.android:/oauth/callback%3Fcode=abc&state=$s",
            "dev.loom.app.android:/oauth/%63allback?code=abc&state=$s",
            "dev.loom.app.android:/oauth/callback?code=abc&state=$s#frag",
            "dev.loom.app.android:/oauth/callback?code=abc&code=def&state=$s",
            "dev.loom.app.android:/oauth/callback?code=abc&state=$s&state=$s",
            "dev.loom.app.android:/oauth/callback?code=abc&state=$s&access_token=t",
            "dev.loom.app.android:/oauth/callback?code=abc&state=$s&refresh_token=t",
            "dev.loom.app.android:/oauth/callback?code=a%62c&state=$s",
            "dev.loom.app.android:/oauth/callback?code=abc&error=x&state=$s",
            "dev.loom.app.android:/oauth/callback?code=&state=$s",
            "dev.loom.app.android:/oauth/callback?code=abc",
            "dev.loom.app.android:/oauth/callback?state=$s",
            "dev.loom.app.android:/oauth/callback",
            "https://loom.example.com/oauth/callback?code=abc&state=$s",
            "dev.loom.app.android:/oauth/callback?code=${"a".repeat(129)}&state=$s",
            ""
        )
        for (uri in hostile) {
            val outcome = a.receive(uri, start + 1)
            assertTrue("accepted: $uri", outcome is CallbackOutcome.Ignored)
        }
        assertTrue(a.receive(null, start + 1) is CallbackOutcome.Ignored)
        // The genuine callback still completes after all of that noise.
        assertEquals(CallbackOutcome.Code("abc"), a.receive("dev.loom.app.android:/oauth/callback?code=abc&state=$s", start + 2))
    }

    @Test
    fun startUrlCarriesExactCallbackAndNoVerifier() {
        val pending = PendingSignIn.create(origin, "dev@example.com", start, SecureRandom())
        val url = URI(pending.startUrl())
        assertEquals("https", url.scheme)
        assertEquals("loom.example.com", url.host)
        assertEquals("/auth/start", url.path)
        val query = url.rawQuery.split('&').associate { it.substringBefore('=') to it.substringAfter('=') }
        assertEquals(setOf("redirect_uri", "code_challenge", "state", "nonce"), query.keys)
        assertEquals("dev.loom.app.android%3A%2Foauth%2Fcallback", query["redirect_uri"])
        assertEquals(Pkce.challenge(pending.verifier), query["code_challenge"])
        assertTrue(!url.rawQuery.contains(pending.verifier))
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(pending.state))
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(pending.nonce))
        assertNotEquals(pending.state, pending.nonce)
    }

    @Test
    fun pkceIsUnpaddedBase64UrlOfSha256() {
        // FIPS 180-2 test vector: SHA-256("abc").
        val challenge = Pkce.challenge("abc")
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(challenge))
        val hex = java.util.Base64.getUrlDecoder().decode(challenge).joinToString("") { "%02x".format(it) }
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", hex)
        val v = Pkce.newSecret(SecureRandom())
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(v))
    }

    @Test
    fun originMustBeABareHttpsHostname() {
        assertEquals("loom.example.com", SignInInputs.parseOrigin(" https://Loom.Example.com/ ")?.host)
        assertEquals("https://loom.example.com", SignInInputs.parseOrigin("https://loom.example.com")?.base)
        val refused = listOf(
            "http://loom.example.com",
            "loom.example.com",
            "https://user:pw@loom.example.com",
            "https://user@loom.example.com",
            "https://loom.example.com:8443",
            "https://loom.example.com/path",
            "https://loom.example.com?x=1",
            "https://loom.example.com#x",
            "https://loom.example.com//",
            "https://127.0.0.1",
            "https://[::1]",
            "https://localhost",
            "https://loom.exa mple.com",
            "https://loom.example.com\\@evil.com",
            "https://loom%2eexample.com",
            "https://lööm.example.com",
            "https://-bad.example.com",
            "https://loom.example.com.",
            "ftp://loom.example.com",
            ""
        )
        for (value in refused) assertNull("accepted $value", SignInInputs.parseOrigin(value))
    }

    @Test
    fun emailIsNormalizedAndValidated() {
        assertEquals("dev@example.com", SignInInputs.normalizeEmail("  Dev@Example.COM "))
        for (bad in listOf("", "dev", "dev@", "@example.com", "dev@exa mple.com", "a b@example.com", "dev@@example.com"))
            assertNull("accepted $bad", SignInInputs.normalizeEmail(bad))
    }
}
