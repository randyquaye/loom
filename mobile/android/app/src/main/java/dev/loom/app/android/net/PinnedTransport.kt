package dev.loom.app.android.net

import dev.loom.app.android.auth.Origin
import dev.loom.app.android.trust.Trust
import dev.loom.app.android.trust.TransportProof
import dev.loom.app.android.trust.TrustException
import okhttp3.ConnectionPool
import okhttp3.ConnectionSpec
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.net.Socket
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509TrustManager

/**
 * Builds one credential-bearing client per connection. Each build fetches and verifies a
 * fresh signed transport proof, re-anchors the org key in DNS for the saved trust domain, and
 * creates a brand-new SSLContext (empty session cache: nothing resumes from unpinned traffic),
 * no connection pooling, no redirects and HTTP/1.1 only.
 */
class PinnedTransport(
    private val publicHttp: PublicHttp,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun open(origin: Origin, domain: String): PinnedClient {
        val reply = publicHttp.getJson("${origin.base}/auth/transport")
        val proof = Trust.parseTransportProof(reply, origin.host, clock())
        Trust.verifyDomainHostKey(domain, origin.host, proof.publicKey, publicHttp.dnsTxt(domain))
        if (clock() >= proof.expiresAt) throw TrustException("The host's TLS proof expired; try again")
        return PinnedClient(origin, build(origin.host, proof))
    }

    private fun build(host: String, proof: TransportProof): OkHttpClient {
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        factory.init(null as KeyStore?)
        val platform = factory.trustManagers.filterIsInstance<X509TrustManager>().first()
        val pinning = PinningTrustManager(platform, proof, clock)
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(pinning), SecureRandom())
        return OkHttpClient.Builder()
            .sslSocketFactory(context.socketFactory, pinning)
            .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
            .protocols(listOf(Protocol.HTTP_1_1))
            .connectionPool(ConnectionPool(0, 1, TimeUnit.MILLISECONDS))
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .cache(null)
            .addNetworkInterceptor(LeafCheck(host, proof, clock))
            .connectTimeout(HTTP_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(HTTP_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .callTimeout(HTTP_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
    }
}

/** A single-use pinned client for one origin. Close it when its request or socket ends. */
class PinnedClient(private val origin: Origin, private val client: OkHttpClient) {
    private fun url(path: String): String {
        require(path.startsWith("/") && !path.startsWith("//") && !path.contains('\\')) { "Invalid path" }
        return origin.base + path
    }

    suspend fun postForm(path: String, fields: Map<String, String>): HttpReply = try {
        client.exchange(
            Request.Builder().url(url(path)).header("Accept", "application/json").post(formBody(fields)).build()
        )
    } finally {
        close()
    }

    /** A WebSocket to this client's own origin; client pings detect dead links. */
    fun webSocket(request: Request, listener: WebSocketListener): WebSocket {
        require(request.isHttps && request.url.host == origin.host && request.url.port == 443) { "Not this client's host" }
        val socketClient = client.newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
        return socketClient.newWebSocket(request, listener)
    }

    fun close() {
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
    }
}

/**
 * Normal platform CA + chain validation (system anchors only, per network security config),
 * then the signed proof must still be current and the leaf SPKI must be the signed key.
 * Failing here aborts the handshake before any request byte is written.
 */
private class PinningTrustManager(
    private val platform: X509TrustManager,
    private val proof: TransportProof,
    private val clock: () -> Long,
) : X509ExtendedTrustManager() {
    private fun pin(chain: Array<out X509Certificate>?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("No server certificate")
        if (!Trust.leafMatches(proof, leaf.publicKey.encoded, clock())) {
            throw CertificateException("The TLS connection does not belong to the authorized host")
        }
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        platform.checkServerTrusted(chain, authType)
        pin(chain)
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) {
        if (platform is X509ExtendedTrustManager) platform.checkServerTrusted(chain, authType, socket)
        else platform.checkServerTrusted(chain, authType)
        pin(chain)
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) {
        if (platform is X509ExtendedTrustManager) platform.checkServerTrusted(chain, authType, engine)
        else platform.checkServerTrusted(chain, authType)
        pin(chain)
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
        throw CertificateException("Client certificates are not accepted")

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) =
        throw CertificateException("Client certificates are not accepted")

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) =
        throw CertificateException("Client certificates are not accepted")

    override fun getAcceptedIssuers(): Array<X509Certificate> = platform.acceptedIssuers
}

/** Second, independent check on the established connection before the request is written. */
private class LeafCheck(
    private val host: String,
    private val proof: TransportProof,
    private val clock: () -> Long,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        // The raw session chain from the socket itself, not a cleaned or cached copy.
        val session = (chain.connection()?.socket() as? SSLSocket)?.session
        val leaf = runCatching { session?.peerCertificates?.firstOrNull() as? X509Certificate }.getOrNull()
        if (!request.isHttps || request.url.host != host || chain.request().header("Origin") != null ||
            leaf == null || !Trust.leafMatches(proof, leaf.publicKey.encoded, clock())
        ) {
            throw IOException("The TLS connection does not belong to the authorized host")
        }
        return chain.proceed(request)
    }
}
