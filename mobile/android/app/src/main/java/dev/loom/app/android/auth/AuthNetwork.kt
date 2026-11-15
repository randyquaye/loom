package dev.loom.app.android.auth

import dev.loom.app.android.net.HttpReply
import dev.loom.app.android.net.PinnedTransport
import dev.loom.app.android.net.PublicHttp

/** The network as authentication needs it. Implemented over OkHttp; faked in tests. */
interface AuthNetwork {
    /** `/auth/proof` over public HTTPS. Carries the browser code, never the PKCE verifier. */
    suspend fun proof(origin: Origin, fields: Map<String, String>): HttpReply
    suspend fun googleKeys(): Any?
    suspend fun dnsTxt(domain: String): Any?
    /** A form POST to the host over a freshly proved, pinned connection for [domain]. */
    suspend fun pinnedPost(origin: Origin, domain: String, path: String, fields: Map<String, String>): HttpReply
}

class OkHttpAuthNetwork(
    private val http: PublicHttp,
    private val transport: PinnedTransport,
) : AuthNetwork {
    override suspend fun proof(origin: Origin, fields: Map<String, String>): HttpReply =
        http.postForm("${origin.base}/auth/proof", fields)

    override suspend fun googleKeys(): Any? = http.googleKeys()

    override suspend fun dnsTxt(domain: String): Any? = http.dnsTxt(domain)

    override suspend fun pinnedPost(origin: Origin, domain: String, path: String, fields: Map<String, String>): HttpReply =
        transport.open(origin, domain).postForm(path, fields)
}
