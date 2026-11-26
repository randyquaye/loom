package dev.loom.app.android.trust

import com.google.crypto.tink.subtle.Ed25519Sign
import dev.loom.app.android.core.Json
import java.io.File
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.util.Base64

/** Test-only signers: ephemeral keys, never written anywhere, used to vary one claim at a time. */
object TestSigners {
    private val url = Base64.getUrlEncoder().withoutPadding()
    private val std = Base64.getEncoder()

    @Suppress("UNCHECKED_CAST")
    fun fixture(): MutableMap<String, Any?> {
        val path = System.getProperty("loom.trustFixture")
            ?: error("loom.trustFixture system property is not set by Gradle")
        return Json.parse(File(path).readText()) as MutableMap<String, Any?>
    }

    class Rsa(val kid: String = "test-rsa") {
        private val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()

        fun jwks(): Map<String, Any?> {
            val key = pair.public as RSAPublicKey
            fun unsigned(bytes: ByteArray) = if (bytes[0] == 0.toByte()) bytes.copyOfRange(1, bytes.size) else bytes
            return mapOf(
                "keys" to listOf(
                    mapOf(
                        "kty" to "RSA",
                        "alg" to "RS256",
                        "kid" to kid,
                        "n" to url.encodeToString(unsigned(key.modulus.toByteArray())),
                        "e" to url.encodeToString(unsigned(key.publicExponent.toByteArray()))
                    )
                )
            )
        }

        fun jwt(claims: Map<String, Any?>, header: Map<String, Any?> = mapOf("alg" to "RS256", "kid" to kid)): String {
            val body = url.encodeToString(Json.encode(header).toByteArray()) + "." +
                url.encodeToString(Json.encode(claims).toByteArray())
            val signature = Signature.getInstance("SHA256withRSA").run {
                initSign(pair.private)
                update(body.toByteArray())
                sign()
            }
            return body + "." + url.encodeToString(signature)
        }
    }

    class Ed {
        private val pair = Ed25519Sign.KeyPair.newKeyPair()
        private val signer = Ed25519Sign(pair.privateKey)
        val spki: ByteArray = hex("302a300506032b6570032100") + pair.publicKey
        val spkiBase64: String = std.encodeToString(spki)
        val fingerprint: String = std.encodeToString(MessageDigest.getInstance("SHA-256").digest(spki))

        fun sign(text: String): String = std.encodeToString(signer.sign(text.toByteArray(Charsets.UTF_8)))
    }

    fun dns(domain: String, host: String, fingerprint: String, name: String = "_loom.$domain."): Map<String, Any?> =
        mapOf(
            "Status" to 0L,
            "Answer" to listOf(mapOf("name" to name, "type" to 16L, "data" to "\"loom-host=$host; key=$fingerprint\""))
        )

    fun hex(value: String): ByteArray = ByteArray(value.length / 2) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
