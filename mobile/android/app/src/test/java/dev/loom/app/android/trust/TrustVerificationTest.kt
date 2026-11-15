package dev.loom.app.android.trust

import dev.loom.app.android.core.Json
import dev.loom.app.android.trust.TestSigners.dns
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest
import java.util.Base64

/**
 * Acceptance tests for independent host verification. The shared fixture is produced by
 * Node's crypto exactly as the runner signs; Kotlin must accept it and refuse every mutation.
 */
@Suppress("UNCHECKED_CAST")
class TrustVerificationTest {
    private val fx = TestSigners.fixture()
    private val now = fx["now"] as Long
    private val host = fx["host"] as String
    private val domain = fx["domain"] as String
    private val email = fx["expectedEmail"] as String
    private val nonce = fx["nonce"] as String
    private val idToken = fx["idToken"] as String
    private val jwks = fx["jwks"]
    private val hostProof = fx["hostProof"] as Map<String, Any?>
    private val transport = fx["transportProof"] as Map<String, Any?>
    private val dnsReply = fx["dns"]

    private fun refuses(block: () -> Unit) {
        assertThrows(TrustException::class.java) { block() }
    }

    private fun copy(value: Any?): Any? = Json.parse(Json.encode(value))
    private fun mutableCopy(value: Any?) = copy(value) as MutableMap<String, Any?>

    private fun flip(base64: String): String {
        val bytes = Base64.getDecoder().decode(base64)
        bytes[bytes.size / 2] = (bytes[bytes.size / 2].toInt() xor 1).toByte()
        return Base64.getEncoder().encodeToString(bytes)
    }

    // ---- The authentic shared fixture ------------------------------------------------------

    @Test
    fun sharedFixtureVerifiesEndToEnd() {
        val identity = Trust.verifyGoogleIdentity(idToken, jwks, nonce, email, now)
        assertEquals(domain, identity.domain)
        assertEquals(email, identity.email)
        Trust.verifyHostBinding(identity.domain, host, nonce, hostProof, dnsReply)
        val proof = Trust.verifyTransportProof(transport, host, domain, dnsReply, now)
        assertEquals(transport["tls_fingerprint"], proof.tlsFingerprint)
        assertEquals(transport["expires_at"], proof.expiresAt)
    }

    @Test
    fun typedEmailIsTrimmedAndCaseInsensitive() {
        Trust.verifyGoogleIdentity(idToken, jwks, nonce, "  ${email.uppercase()} ", now)
    }

    @Test
    fun canonicalPayloadDoesNotEscapeSlashes() {
        val fingerprint = transport["tls_fingerprint"] as String
        assertTrue(fingerprint.contains('/'))
        val payload = Trust.transportProofPayload(host, fingerprint, 1L, 2L)
        assertFalse(payload.contains("\\/"))
        assertEquals("[\"loom.transport-proof.v1\",\"$host\",\"$fingerprint\",1,2]", payload)
        assertEquals("[\"loom.host-proof.v1\",\"$host\",\"$nonce\"]", Trust.hostProofPayload(host, nonce))
    }

    // ---- Google identity ------------------------------------------------------------------

    @Test
    fun refusesTamperedGoogleSignature() {
        val parts = idToken.split('.')
        val sig = Base64.getUrlDecoder().decode(parts[2])
        sig[10] = (sig[10].toInt() xor 1).toByte()
        val forged = parts[0] + "." + parts[1] + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(sig)
        refuses { Trust.verifyGoogleIdentity(forged, jwks, nonce, email, now) }
    }

    @Test
    fun refusesSwappedClaimsUnderTheOriginalSignature() {
        val parts = idToken.split('.')
        val claims = Json.parse(String(Base64.getUrlDecoder().decode(parts[1]))) as MutableMap<String, Any?>
        claims["email"] = "attacker@example.com"
        val swapped = parts[0] + "." + Base64.getUrlEncoder().withoutPadding()
            .encodeToString(Json.encode(claims).toByteArray()) + "." + parts[2]
        refuses { Trust.verifyGoogleIdentity(swapped, jwks, nonce, "attacker@example.com", now) }
    }

    @Test
    fun refusesWrongEmailAndNonceAndExpiryFromFixture() {
        refuses { Trust.verifyGoogleIdentity(idToken, jwks, nonce, "someone@example.com", now) }
        refuses { Trust.verifyGoogleIdentity(idToken, jwks, "another-nonce-0123456789abcdef0123456789", email, now) }
        refuses { Trust.verifyGoogleIdentity(idToken, jwks, "", email, now) }
        // exp is now + 300 s.
        refuses { Trust.verifyGoogleIdentity(idToken, jwks, nonce, email, now + 300_000) }
        // iat is now - 10 s; older than 600 s is refused.
        refuses { Trust.verifyGoogleIdentity(idToken, jwks, nonce, email, now + 600_000 - 10_000 + 1_000) }
        // A clock far behind the token's issue time.
        refuses { Trust.verifyGoogleIdentity(idToken, jwks, nonce, email, now - 75_000) }
    }

    @Test
    fun refusesUnknownKeyOrWrongKeyType() {
        val other = TestSigners.Rsa("loom-fixture-rsa").jwks()
        refuses { Trust.verifyGoogleIdentity(idToken, other, nonce, email, now) }
        val wrongAlg = mutableCopy(jwks)
        ((wrongAlg["keys"] as MutableList<Any?>)[0] as MutableMap<String, Any?>)["alg"] = "RS512"
        refuses { Trust.verifyGoogleIdentity(idToken, wrongAlg, nonce, email, now) }
        refuses { Trust.verifyGoogleIdentity(idToken, mapOf("keys" to emptyList<Any?>()), nonce, email, now) }
    }

    private val rsa = TestSigners.Rsa()
    private val nowSeconds = now / 1000
    private fun claims(vararg overrides: Pair<String, Any?>): Map<String, Any?> {
        val base = linkedMapOf<String, Any?>(
            "iss" to "accounts.google.com",
            "sub" to "subject-1",
            "email" to email,
            "email_verified" to true,
            "hd" to domain,
            "nonce" to nonce,
            "iat" to nowSeconds - 5,
            "exp" to nowSeconds + 600
        )
        for ((key, value) in overrides) if (value == null) base.remove(key) else base[key] = value
        return base
    }
    private fun google(claims: Map<String, Any?>, header: Map<String, Any?>? = null) =
        Trust.verifyGoogleIdentity(
            if (header == null) rsa.jwt(claims) else rsa.jwt(claims, header), rsa.jwks(), nonce, email, now
        )

    @Test
    fun acceptsBothIssuerFormsAndStringVerifiedFlag() {
        google(claims())
        google(claims("iss" to "https://accounts.google.com", "email_verified" to "true"))
    }

    @Test
    fun refusesEachIdentityRuleIndividually() {
        refuses { google(claims("iss" to "https://evil.example")) }
        refuses { google(claims("email_verified" to false)) }
        refuses { google(claims("email_verified" to null)) }
        refuses { google(claims("hd" to null)) }
        refuses { google(claims("hd" to "Not A Domain")) }
        refuses { google(claims("sub" to "")) }
        refuses { google(claims("exp" to nowSeconds)) }
        refuses { google(claims("iat" to nowSeconds + 61)) }
        refuses { google(claims("iat" to nowSeconds - 601)) }
        refuses { google(claims("nonce" to "replayed-nonce-0123456789abcdef0123456789")) }
        refuses { google(claims("email" to "Developer+alias@example.com")) }
        refuses { google(claims(), mapOf("alg" to "none", "kid" to rsa.kid)) }
        refuses { google(claims(), mapOf("alg" to "HS256", "kid" to rsa.kid)) }
        refuses { google(claims(), mapOf("alg" to "RS256")) }
        refuses { Trust.verifyGoogleIdentity("a.b", rsa.jwks(), nonce, email, now) }
        refuses { Trust.verifyGoogleIdentity("x".repeat(40_000), rsa.jwks(), nonce, email, now) }
    }

    // ---- DNS anchoring and the host proof --------------------------------------------------

    @Test
    fun refusesTamperedHostProof() {
        val tampered = hostProof.toMutableMap().apply { this["signature"] = flip(hostProof["signature"] as String) }
        refuses { Trust.verifyHostBinding(domain, host, nonce, tampered, dnsReply) }
        refuses { Trust.verifyHostBinding(domain, host, "a-different-nonce-0123456789abcdef01234", hostProof, dnsReply) }
        val otherHost = hostProof.toMutableMap().apply { this["host"] = "evil.example.com" }
        refuses { Trust.verifyHostBinding(domain, host, nonce, otherHost, dnsReply) }
        refuses { Trust.verifyHostBinding(domain, "evil.example.com", nonce, hostProof, dnsReply) }
    }

    @Test
    fun refusesHostProofFromAKeyDnsDoesNotList() {
        val impostor = TestSigners.Ed()
        val proof = mapOf(
            "host" to host,
            "public_key" to impostor.spkiBase64,
            "signature" to impostor.sign(Trust.hostProofPayload(host, nonce))
        )
        refuses { Trust.verifyHostBinding(domain, host, nonce, proof, dnsReply) }
        // The same impostor with its own DNS record is accepted: DNS is the anchor.
        Trust.verifyHostBinding(domain, host, nonce, proof, dns(domain, host, impostor.fingerprint))
    }

    @Test
    fun refusesNonExactDnsAnswers() {
        val key = hostProof["public_key"] as String
        val fingerprint = Base64.getEncoder().encodeToString(
            MessageDigest.getInstance("SHA-256").digest(Base64.getDecoder().decode(key))
        )
        val good = dns(domain, host, fingerprint)
        assertEquals(32, Trust.verifyDomainHostKey(domain, host, key, good).size)

        fun variant(edit: (MutableMap<String, Any?>, MutableMap<String, Any?>) -> Unit): Any? {
            val reply = mutableCopy(good)
            edit(reply, (reply["Answer"] as MutableList<Any?>)[0] as MutableMap<String, Any?>)
            return reply
        }
        refuses { Trust.verifyDomainHostKey(domain, host, key, variant { r, _ -> r["Status"] = 2L }) }
        refuses { Trust.verifyDomainHostKey(domain, host, key, variant { _, a -> a["type"] = 5L }) }
        refuses { Trust.verifyDomainHostKey(domain, host, key, variant { _, a -> a["name"] = "_loom.evil.com." }) }
        refuses { Trust.verifyDomainHostKey(domain, host, key, variant { _, a -> a["name"] = "x._loom.example.com" }) }
        refuses {
            Trust.verifyDomainHostKey(domain, host, key, variant { _, a ->
                a["data"] = "\"loom-host=loom.example.com.evil.net; key=$fingerprint\""
            })
        }
        refuses {
            Trust.verifyDomainHostKey(domain, host, key, variant { _, a ->
                a["data"] = "\"loom-host=$host; key=${flip(fingerprint)}\""
            })
        }
        refuses {
            Trust.verifyDomainHostKey(domain, host, key, variant { _, a ->
                a["data"] = "\"loom-host=$host; key=$fingerprint\" trailing"
            })
        }
        refuses {
            Trust.verifyDomainHostKey(domain, host, key, variant { _, a ->
                a["data"] = "\"loom-host=$host; key=\\\"$fingerprint\""
            })
        }
        refuses { Trust.verifyDomainHostKey(domain, host, key, mapOf("Status" to 0L)) }
        refuses { Trust.verifyDomainHostKey("example..com", host, key, good) }
        // TXT records may be split into several quoted chunks.
        val split = variant { _, a ->
            a["data"] = "\"loom-host=$host; \" \"key=$fingerprint\""
        }
        Trust.verifyDomainHostKey(domain, host, key, split)
    }

    @Test
    fun refusesMalformedOrNonEd25519Keys() {
        val key = hostProof["public_key"] as String
        val der = Base64.getDecoder().decode(key)
        val fp = { bytes: ByteArray ->
            Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes))
        }
        val short = der.copyOf(43)
        refuses { Trust.verifyDomainHostKey(domain, host, Base64.getEncoder().encodeToString(short), dns(domain, host, fp(short))) }
        val wrongPrefix = der.copyOf().also { it[8] = 0x71 }
        refuses {
            Trust.verifyDomainHostKey(domain, host, Base64.getEncoder().encodeToString(wrongPrefix), dns(domain, host, fp(wrongPrefix)))
        }
        // Non-canonical base64 (trailing garbage bits) must not be accepted as the same key.
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        val nonCanonical = key.dropLast(2) + alphabet[alphabet.indexOf(key[key.length - 2]) xor 1] + "="
        refuses { Trust.verifyDomainHostKey(domain, host, nonCanonical, dns(domain, host, fp(der))) }
        assertArrayEquals(der.copyOfRange(12, 44), Trust.ed25519RawKey(der))
    }

    // ---- Transport proof -------------------------------------------------------------------

    @Test
    fun refusesExpiredFutureOrOverlongTransportProofs() {
        refuses { Trust.verifyTransportProof(transport, host, domain, dnsReply, now + 60_000) }
        // issued_at more than 60 s ahead of the device clock.
        refuses { Trust.verifyTransportProof(transport, host, domain, dnsReply, now - 61_001) }
        val ed = TestSigners.Ed()
        fun signed(issued: Long, expires: Long, fp: String = "A".repeat(43) + "=") = mapOf(
            "host" to host, "public_key" to ed.spkiBase64, "tls_fingerprint" to fp,
            "issued_at" to issued, "expires_at" to expires,
            "signature" to ed.sign(Trust.transportProofPayload(host, fp, issued, expires))
        )
        val anchor = dns(domain, host, ed.fingerprint)
        Trust.verifyTransportProof(signed(now - 1000, now + 900_000 - 1000), host, domain, anchor, now)
        refuses { Trust.verifyTransportProof(signed(now - 1000, now + 900_000), host, domain, anchor, now) }
        refuses { Trust.verifyTransportProof(signed(now, now), host, domain, anchor, now) }
        refuses { Trust.verifyTransportProof(signed(0, now + 1), host, domain, anchor, now) }
    }

    @Test
    fun refusesTamperedTransportFields() {
        for ((field, value) in listOf(
            "tls_fingerprint" to flip(transport["tls_fingerprint"] as String),
            "signature" to flip(transport["signature"] as String),
            "expires_at" to (transport["expires_at"] as Long) + 1,
            "host" to "other.example.com",
            "issued_at" to (transport["issued_at"] as Long).toDouble() + 0.5,
            "public_key" to TestSigners.Ed().spkiBase64
        )) {
            val forged = mutableCopy(transport).apply { this[field] = value }
            refuses { Trust.verifyTransportProof(forged, host, domain, dnsReply, now) }
        }
        // Host A's proof presented while connecting to host B.
        refuses { Trust.verifyTransportProof(transport, "other.example.com", domain, dnsReply, now) }
        // A float timestamp spelled in JSON is not an integer, even when integral.
        val text = Json.encode(transport).replace("\"issued_at\":${transport["issued_at"]}", "\"issued_at\":${transport["issued_at"]}.0")
        refuses { Trust.verifyTransportProof(Json.parse(text), host, domain, dnsReply, now) }
        // A DNS record for another domain cannot anchor this org's key.
        refuses { Trust.verifyTransportProof(transport, host, "example.org", dnsReply, now) }
    }

    @Test
    fun leafKeyMustMatchAndProofMustStillBeCurrentAtHandshake() {
        val proof = Trust.verifyTransportProof(transport, host, domain, dnsReply, now)
        val leaf = ByteArray(91) { 7 }
        assertFalse(Trust.leafMatches(proof, leaf, now))
        val ed = TestSigners.Ed()
        val fp = ed.fingerprint
        val issued = now - 1000
        val expires = now + 1000
        val matching = Trust.verifyTransportProof(
            mapOf(
                "host" to host, "public_key" to ed.spkiBase64, "tls_fingerprint" to fp,
                "issued_at" to issued, "expires_at" to expires,
                "signature" to ed.sign(Trust.transportProofPayload(host, fp, issued, expires))
            ),
            host, domain, dns(domain, host, ed.fingerprint), now
        )
        assertTrue(Trust.leafMatches(matching, ed.spki, now))
        // Valid at fetch, expired by the time the TLS handshake completes.
        assertFalse(Trust.leafMatches(matching, ed.spki, expires))
    }
}
