package dev.loom.app.android.runner

import dev.loom.app.android.auth.AuthManager
import dev.loom.app.android.auth.Origin
import dev.loom.app.android.net.PinnedTransport
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.atomic.AtomicBoolean

/** The `/v1/ws` upgrade: bearer token, the capabilities this app asks for, and no Origin. */
fun runnerSocketRequest(origin: Origin, bearer: String): Request = Request.Builder()
    .url(origin.base + RUNNER_PATH)
    .header("Authorization", "Bearer $bearer")
    .header(CAPABILITIES_HEADER, REQUESTED_CAPABILITIES.joinToString(","))
    .build()

/**
 * Opens `/v1/ws` over a freshly proved, pinned connection. Every socket gets its own
 * transport proof, TLS context and client.
 */
class OkHttpSocketOpener(
    private val auth: AuthManager,
    private val transport: PinnedTransport,
) : SocketOpener {
    override suspend fun open(events: WireEvents, renew: Boolean): WireSocket {
        // One snapshot: the token is only ever sent to the host it was issued for.
        val access = auth.access(renew)
        val pinned = transport.open(access.origin, access.domain)
        val finished = AtomicBoolean(false)

        fun finish(code: Int, status: Int?) {
            if (finished.compareAndSet(false, true)) {
                pinned.close()
                events.onClosed(code, status)
            }
        }

        val socket = pinned.webSocket(
            runnerSocketRequest(access.origin, access.token),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = events.onOpen()

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (text.length > MAX_FRAME_CHARS) webSocket.cancel() else events.onText(text)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    webSocket.close(1003, null)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                    finish(code, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish(code, null)

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    finish(-1, response?.code)
                }
            },
        )
        return object : WireSocket {
            override fun send(text: String): Boolean = socket.send(text)
            override fun close() {
                if (!socket.close(1000, null)) socket.cancel()
            }
        }
    }
}
