package dev.loom.app.android.net

import dev.loom.app.android.core.Json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okio.Buffer
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A reply whose body has been read within a size bound and parsed as JSON (null if not JSON). */
class HttpReply(val status: Int, val json: Any?)

/** The network could not produce a usable answer. Credentials stay valid for a retry. */
class NetworkException(message: String, cause: Throwable? = null) : IOException(message, cause)

const val MAX_PROOF_BYTES = 64 * 1024L
const val HTTP_TIMEOUT_SECONDS = 15L

suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (continuation.isActive) continuation.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            if (continuation.isActive) continuation.resume(response) else response.close()
        }
    })
}

/** Executes, refuses redirects, reads at most [maxBytes] and parses JSON. */
suspend fun OkHttpClient.exchange(request: Request, maxBytes: Long = MAX_PROOF_BYTES): HttpReply {
    val response = try {
        newCall(request).await()
    } catch (error: IOException) {
        throw NetworkException("The network request failed", error)
    }
    return response.use {
        if (it.isRedirect || it.code in 300..399) throw NetworkException("Redirects are refused")
        val text = withContext(Dispatchers.IO) {
            val source = it.body.source()
            val buffer = Buffer()
            while (source.read(buffer, 8192) != -1L) {
                if (buffer.size > maxBytes) throw NetworkException("The reply is too large")
            }
            buffer.readUtf8()
        }
        HttpReply(it.code, if (text.isEmpty()) null else runCatching { Json.parse(text) }.getOrNull())
    }
}

fun formBody(fields: Map<String, String>): FormBody =
    FormBody.Builder().apply { fields.forEach { (k, v) -> add(k, v) } }.build()

/**
 * Unpinned public HTTPS for evidence that carries no Loom credential: Google JWKS,
 * DNS-over-HTTPS, `/auth/proof` and `/auth/transport`. Its TLS sessions live in OkHttp's
 * default context and are never shared with pinned credential connections.
 */
class PublicHttp(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .cache(null)
        .connectTimeout(HTTP_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(HTTP_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .callTimeout(HTTP_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build(),
) {
    suspend fun getJson(url: String, accept: String = "application/json"): Any? {
        val reply = client.exchange(Request.Builder().url(url).header("Accept", accept).get().build())
        if (reply.status !in 200..299 || reply.json == null) {
            throw NetworkException("Verification service unavailable (${reply.status})")
        }
        return reply.json
    }

    suspend fun postForm(url: String, fields: Map<String, String>): HttpReply =
        client.exchange(Request.Builder().url(url).header("Accept", "application/json").post(formBody(fields)).build())

    /** Cloudflare DNS-over-HTTPS JSON; never the system resolver, never cached. */
    suspend fun dnsTxt(domain: String): Any? =
        getJson("https://cloudflare-dns.com/dns-query?name=_loom.$domain&type=TXT", "application/dns-json")

    suspend fun googleKeys(): Any? = getJson("https://www.googleapis.com/oauth2/v3/certs")
}
