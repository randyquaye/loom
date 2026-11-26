package dev.loom.app.android.trust

import com.google.crypto.tink.subtle.Ed25519Verify
import dev.loom.app.android.core.Json
import dev.loom.app.android.core.asList
import dev.loom.app.android.core.asObject
import dev.loom.app.android.core.long
import dev.loom.app.android.core.number
import dev.loom.app.android.core.string
import java.math.BigInteger
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.RSAPublicKeySpec
import java.util.Base64
import java.util.Locale

/** Verification refused. Messages are safe to show and never contain credentials. */
class TrustException(message: String) : Exception(message)

data class GoogleIdentity(val email: String, val domain: String, val subject: String)

/** An org-signed authorization of one TLS leaf key for a short interval. */
data class TransportProof(
    val host: String,
    val tlsFingerprint: String,
    val issuedAt: Long,
    val expiresAt: Long,
    val publicKey: String,
)

/**
 * Pure, network-free verification of the independent evidence a Loom host must present,
 * matching the desktop (src/main/cloud/host-proof.ts, transport.ts, auth/transport-proof.ts)
 * and stricter where canonical encodings are concerned. Callers fetch inputs themselves.
 */
object Trust {
    val DOMAIN = Regex(
        "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
    )
    private val SEGMENT = Regex("^[A-Za-z0-9_-]+$")
    private val NONCE = Regex("^[A-Za-z0-9_-]{16,128}$")
    private val TXT_RECORD = Regex("^loom-host=([^;\\s]+);\\s*key=([A-Za-z0-9+/]{43}=)$")
    private val TXT_CHUNK = Regex("\"[^\"\\\\]*\"")
    private val SPKI_PREFIX = byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
    )
    private const val MAX_ID_TOKEN = 32768
    private const val MAX_TOKEN_AGE_SECONDS = 600L
    private const val FUTURE_SKEW_SECONDS = 60L
    const val TRANSPORT_TTL_MS = 15 * 60_000L
    private const val TRANSPORT_SKEW_MS = 60_000L
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    private fun refused(reason: String): Nothing =
        throw TrustException("The organization's host could not be verified: $reason")

    // ---- Encoding helpers -----------------------------------------------------------------

    /** Standard base64 that re-encodes to exactly the same text: one key, one spelling. */
    fun canonicalBase64(value: Any?, bytes: Int? = null, maxChars: Int = 1024): ByteArray? {
        if (value !is String || value.isEmpty() || value.length > maxChars) return null
        val decoded = try {
            Base64.getDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (Base64.getEncoder().encodeToString(decoded) != value) return null
        if (bytes != null && decoded.size != bytes) return null
        return decoded
    }

    /** The raw 32-byte key of a canonical 44-byte Ed25519 SubjectPublicKeyInfo, or null. */
    fun ed25519RawKey(spki: ByteArray): ByteArray? {
        if (spki.size != 44) return null
        for (i in SPKI_PREFIX.indices) if (spki[i] != SPKI_PREFIX[i]) return null
        return spki.copyOfRange(12, 44)
    }

    fun sha256Base64(bytes: ByteArray): String =
        Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes))

    private fun ed25519Verifies(rawKey: ByteArray, signature: ByteArray, message: String): Boolean = try {
        Ed25519Verify(rawKey).verify(signature, message.toByteArray(Charsets.UTF_8))
        true
    } catch (_: GeneralSecurityException) {
        false
    } catch (_: IllegalArgumentException) {
        false
    }

    /** JSON.stringify(['loom.host-proof.v1', host, nonce]) with no '/' escaping. */
    fun hostProofPayload(host: String, nonce: String): String =
        Json.encode(listOf("loom.host-proof.v1", host, nonce))

    /** JSON.stringify(['loom.transport-proof.v1', host, fingerprint, issuedAt, expiresAt]). */
    fun transportProofPayload(host: String, fingerprint: String, issuedAt: Long, expiresAt: Long): String =
        Json.encode(listOf("loom.transport-proof.v1", host, fingerprint, issuedAt, expiresAt))

    // ---- Google identity ------------------------------------------------------------------

    fun verifyGoogleIdentity(
        idToken: String,
        jwks: Any?,
        nonce: String,
        expectedEmail: String,
        nowMs: Long,
    ): GoogleIdentity {
        val expected = expectedEmail.trim().lowercase(Locale.ROOT)
        if (expected.isEmpty()) refused("enter your work email before signing in")
        if (!NONCE.matches(nonce)) refused("invalid sign-in attempt")
        if (idToken.length > MAX_ID_TOKEN) refused("invalid Google token")
        val segments = idToken.split('.')
        if (segments.size != 3 || segments.any { !SEGMENT.matches(it) }) refused("invalid Google token")
        val header = decodeSegment(segments[0])
        val claims = decodeSegment(segments[1])
        val kid = header.string("kid")
        if (header["alg"] != "RS256" || kid == null) refused("invalid Google signing key")

        val key = jwks.asObject()?.get("keys").asList()
            ?.mapNotNull { it.asObject() }
            ?.firstOrNull { it["kid"] == kid && it["kty"] == "RSA" && it["alg"] == "RS256" }
            ?: refused("Google did not publish this signing key")
        val authentic = try {
            val modulus = BigInteger(1, Base64.getUrlDecoder().decode(key.string("n") ?: ""))
            val exponent = BigInteger(1, Base64.getUrlDecoder().decode(key.string("e") ?: ""))
            if (modulus.bitLength() !in 2048..8192 || exponent.signum() <= 0) refused("invalid Google signing key")
            val publicKey = KeyFactory.getInstance("RSA").generatePublic(RSAPublicKeySpec(modulus, exponent))
            Signature.getInstance("SHA256withRSA").run {
                initVerify(publicKey)
                update("${segments[0]}.${segments[1]}".toByteArray(Charsets.US_ASCII))
                verify(Base64.getUrlDecoder().decode(segments[2]))
            }
        } catch (error: TrustException) {
            throw error
        } catch (_: Exception) {
            false
        }
        if (!authentic) refused("invalid Google signature")

        val now = Math.floorDiv(nowMs, 1000L).toDouble()
        val exp = claims.number("exp")
        val iat = claims.number("iat")
        val verified = claims["email_verified"]
        val email = claims.string("email")
        val subject = claims.string("sub")
        val issuer = claims["iss"]
        if (
            (issuer != "https://accounts.google.com" && issuer != "accounts.google.com") ||
            exp == null || exp <= now ||
            iat == null || iat > now + FUTURE_SKEW_SECONDS || now - iat > MAX_TOKEN_AGE_SECONDS ||
            claims["nonce"] != nonce ||
            (verified != true && verified != "true") ||
            email == null || email.lowercase(Locale.ROOT) != expected ||
            subject.isNullOrEmpty()
        ) {
            refused("Google identity is missing, expired, or belongs to another sign-in")
        }
        val domain = claims.string("hd")?.lowercase(Locale.ROOT) ?: ""
        if (!DOMAIN.matches(domain)) refused("a verified Google Workspace account is required")
        return GoogleIdentity(email = expected, domain = domain, subject = subject)
    }

    private fun decodeSegment(segment: String): Map<String, Any?> = try {
        Json.parse(String(Base64.getUrlDecoder().decode(segment), Charsets.UTF_8)).asObject()
    } catch (_: Exception) {
        null
    } ?: refused("invalid Google token")

    // ---- DNS anchoring and host proof -------------------------------------------------------

    /**
     * The org signing key as listed in DNS-over-HTTPS TXT `_loom.<domain>`: exact record name,
     * exact host and the SHA-256 of the canonical Ed25519 SPKI. Returns the raw 32-byte key.
     */
    fun verifyDomainHostKey(domain: String, host: String, encodedKey: String, dns: Any?): ByteArray {
        if (!DOMAIN.matches(domain) || !DOMAIN.matches(host) || encodedKey.length > 512) {
            refused("invalid Workspace domain or runner key")
        }
        val der = canonicalBase64(encodedKey, maxChars = 512) ?: refused("the runner key is malformed")
        val raw = ed25519RawKey(der) ?: refused("the runner key is not Ed25519")
        val fingerprint = sha256Base64(der)
        val reply = dns.asObject() ?: refused("invalid DNS reply")
        val expectedName = "_loom.$domain"
        val listed = reply["Status"] == 0L && (reply["Answer"].asList() ?: emptyList()).any { item ->
            val answer = item.asObject() ?: return@any false
            val name = answer.string("name") ?: return@any false
            val data = answer.string("data") ?: return@any false
            if (answer["type"] != 16L || name.lowercase(Locale.ROOT).removeSuffix(".") != expectedName) {
                return@any false
            }
            val match = txtValue(data)?.trim()?.let { TXT_RECORD.matchEntire(it) } ?: return@any false
            match.groupValues[1].lowercase(Locale.ROOT) == host && match.groupValues[2] == fingerprint
        }
        if (!listed) refused("$expectedName does not list this host and signing key")
        return raw
    }

    /** Concatenated quoted TXT chunks. Escapes are refused outright (stricter than desktop). */
    private fun txtValue(data: String): String? {
        if (data.contains('\\')) return null
        val chunks = TXT_CHUNK.findAll(data).map { it.value }.toList()
        if (chunks.isEmpty() || TXT_CHUNK.replace(data, "").isNotBlank()) return null
        return chunks.joinToString("") { it.substring(1, it.length - 1) }
    }

    /** The runner holds the DNS-listed key for this host, signed over our fresh nonce. */
    fun verifyHostBinding(domain: String, host: String, nonce: String, hostProof: Any?, dns: Any?) {
        val proof = hostProof.asObject() ?: refused("the runner did not return its sign-in proof")
        val publicKey = proof.string("public_key")
        if (proof["host"] != host || publicKey == null || proof["signature"] !is String) {
            refused("the runner proof names another host")
        }
        if (!NONCE.matches(nonce)) refused("invalid sign-in attempt")
        val raw = verifyDomainHostKey(domain, host, publicKey, dns)
        val signature = canonicalBase64(proof["signature"], 64)
            ?: refused("the runner could not prove it holds the listed signing key")
        if (!ed25519Verifies(raw, signature, hostProofPayload(host, nonce))) {
            refused("the runner could not prove it holds the listed signing key")
        }
    }

    // ---- Transport proof --------------------------------------------------------------------

    /** Syntax, freshness and self-signature. The key must still be anchored by DNS. */
    fun parseTransportProof(value: Any?, host: String, nowMs: Long): TransportProof {
        val proof = value.asObject() ?: refused("invalid transport proof")
        val issued = proof.long("issued_at")
        val expires = proof.long("expires_at")
        if (
            proof["host"] != host || issued == null || expires == null ||
            issued <= 0 || expires <= issued || expires > MAX_SAFE_INTEGER ||
            expires - issued > TRANSPORT_TTL_MS ||
            issued > nowMs + TRANSPORT_SKEW_MS || expires <= nowMs
        ) {
            refused("the transport proof is expired or names another host")
        }
        val fingerprint = proof.string("tls_fingerprint")
        val publicKey = proof.string("public_key")
        val signature = canonicalBase64(proof["signature"], 64)
        val spki = canonicalBase64(publicKey)
        val raw = spki?.let { ed25519RawKey(it) }
        if (fingerprint == null || canonicalBase64(fingerprint, 32) == null || publicKey == null ||
            signature == null || raw == null
        ) {
            refused("the transport proof is malformed")
        }
        if (!ed25519Verifies(raw, signature, transportProofPayload(host, fingerprint, issued, expires))) {
            refused("the transport proof signature is invalid")
        }
        return TransportProof(host, fingerprint, issued, expires, publicKey)
    }

    /** Parse plus independent DNS anchoring of the signing key for the saved trust domain. */
    fun verifyTransportProof(value: Any?, host: String, domain: String, dns: Any?, nowMs: Long): TransportProof {
        val proof = parseTransportProof(value, host, nowMs)
        verifyDomainHostKey(domain, host, proof.publicKey, dns)
        return proof
    }

    /** At the TLS handshake: the proof is still current and the leaf SPKI is the signed one. */
    fun leafMatches(proof: TransportProof, leafSpki: ByteArray, nowMs: Long): Boolean =
        nowMs < proof.expiresAt && MessageDigest.isEqual(
            sha256Base64(leafSpki).toByteArray(Charsets.US_ASCII),
            proof.tlsFingerprint.toByteArray(Charsets.US_ASCII)
        )
}
