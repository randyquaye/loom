package dev.loom.app.android.auth

import dev.loom.app.android.trust.Trust
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.Locale

/** An organization host the person typed: https, a bare DNS hostname, nothing else. */
data class Origin(val host: String) {
    val base: String get() = "https://$host"
}

object SignInInputs {
    private val IPV4ISH = Regex("^[0-9.]+$")
    private val LOCAL = Regex("^[^\\s@\"(),:;<>\\[\\]\\\\]{1,64}$")

    /** Accepts exactly `https://host` or `https://host/`; refuses ports, paths, userinfo and IPs. */
    fun parseOrigin(input: String): Origin? {
        val text = input.trim()
        if (text.length > 270 || !text.regionMatches(0, "https://", 0, 8, ignoreCase = true)) return null
        var rest = text.substring(8)
        if (rest.endsWith("/")) rest = rest.dropLast(1)
        val host = rest.lowercase(Locale.ROOT)
        if (host.isEmpty() || host.any { it.code > 0x7E || it.code <= 0x20 }) return null
        if (!Trust.DOMAIN.matches(host) || IPV4ISH.matches(host)) return null
        return Origin(host)
    }

    /** The primary work email, typed by the person on every sign-in; never prefilled from links. */
    fun normalizeEmail(input: String): String? {
        val email = input.trim().lowercase(Locale.ROOT)
        if (email.length > 254) return null
        val at = email.indexOf('@')
        if (at <= 0 || at != email.lastIndexOf('@')) return null
        val local = email.substring(0, at)
        val domain = email.substring(at + 1)
        return if (LOCAL.matches(local) && Trust.DOMAIN.matches(domain)) email else null
    }
}

object Pkce {
    /** 32 CSPRNG bytes, base64url without padding (43 characters). */
    fun newSecret(random: SecureRandom): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(random::nextBytes))

    fun challenge(verifier: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
    )
}

/** One browser sign-in in flight. The verifier never leaves memory until both proofs pass. */
class PendingSignIn private constructor(
    val origin: Origin,
    val email: String,
    val verifier: String,
    val state: String,
    val nonce: String,
    val startedAtMs: Long,
) {
    fun startUrl(): String {
        fun enc(value: String) = URLEncoder.encode(value, "UTF-8")
        return "${origin.base}/auth/start?redirect_uri=${enc(OAuthCallback.REDIRECT_URI)}" +
            "&code_challenge=${enc(Pkce.challenge(verifier))}&state=${enc(state)}&nonce=${enc(nonce)}"
    }

    companion object {
        const val LIFETIME_MS = 10 * 60_000L

        fun create(origin: Origin, email: String, nowMs: Long, random: SecureRandom) = PendingSignIn(
            origin = origin,
            email = email,
            verifier = Pkce.newSecret(random),
            state = Pkce.newSecret(random),
            nonce = Pkce.newSecret(random),
            startedAtMs = nowMs,
        )
    }
}

sealed interface CallbackOutcome {
    data class Code(val code: String) : CallbackOutcome
    data object Refused : CallbackOutcome
    data object Expired : CallbackOutcome
    data class Ignored(val reason: String) : CallbackOutcome
}

object OAuthCallback {
    /** Exact private-use redirect allowlisted by the runner. Never derived from input. */
    const val REDIRECT_URI = "dev.loom.app.android:/oauth/callback"
    private val VALUE = Regex("^[A-Za-z0-9._~-]{1,128}$")
    private val ALLOWED = setOf("code", "state", "error")

    /** Exact prefix, no fragment, no percent-encoding, unique known fields only. */
    fun parse(raw: String?): Map<String, String>? {
        if (raw == null || raw.length > 4096 || raw.contains('#')) return null
        val prefix = "$REDIRECT_URI?"
        if (!raw.startsWith(prefix)) return null
        val fields = HashMap<String, String>()
        for (part in raw.substring(prefix.length).split('&')) {
            val eq = part.indexOf('=')
            if (eq <= 0) return null
            val key = part.substring(0, eq)
            val value = part.substring(eq + 1)
            if (key !in ALLOWED || fields.containsKey(key) || !VALUE.matches(value)) return null
            fields[key] = value
        }
        return fields
    }
}

/** Accepts at most one completion for one pending sign-in. Not thread-safe; confine to one thread. */
class SignInAttempt(val pending: PendingSignIn) {
    var finished = false
        private set

    fun receive(raw: String?, nowMs: Long): CallbackOutcome {
        if (finished) return CallbackOutcome.Ignored("This sign-in already finished")
        val fields = OAuthCallback.parse(raw) ?: return CallbackOutcome.Ignored("Not a Loom sign-in callback")
        val state = fields["state"] ?: return CallbackOutcome.Ignored("Missing state")
        if (!MessageDigest.isEqual(state.toByteArray(), pending.state.toByteArray())) {
            return CallbackOutcome.Ignored("This is not a sign-in Loom started")
        }
        val code = fields["code"]
        val error = fields["error"]
        if ((code == null) == (error == null)) return CallbackOutcome.Ignored("Malformed callback")
        finished = true
        if (nowMs - pending.startedAtMs > PendingSignIn.LIFETIME_MS || nowMs < pending.startedAtMs) {
            return CallbackOutcome.Expired
        }
        return if (code != null) CallbackOutcome.Code(code) else CallbackOutcome.Refused
    }
}
