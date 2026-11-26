package dev.loom.app.android.runner

import dev.loom.app.android.core.Json
import dev.loom.app.android.core.asObject
import dev.loom.app.android.core.list
import dev.loom.app.android.core.long
import dev.loom.app.android.core.string
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.IOException
import java.util.concurrent.atomic.AtomicLong

/** The stable base protocol. What is newer than it is negotiated as a named capability. */
const val RUNNER_PROTOCOL = 6
const val RUNNER_PATH = "/v1/ws"

/** Sent with every connection; the host's hello lists the ones it grants. */
const val CAPABILITIES_HEADER = "x-loom-capabilities"
const val BOTS_CAPABILITY = "bots.v1"
const val MOBILE_CAPABILITY = "mobile.v1"
val REQUESTED_CAPABILITIES = listOf(BOTS_CAPABILITY, MOBILE_CAPABILITY)
const val CLOSE_UPDATE_REQUIRED = 4400
const val CLOSE_SIGNED_OUT = 4401
const val MAX_FRAME_CHARS = 32 * 1024 * 1024

sealed interface LinkState {
    data object Idle : LinkState
    data object Connecting : LinkState
    data object Connected : LinkState
    data object Paused : LinkState
    data class Offline(val message: String) : LinkState
    data object SignedOut : LinkState
    data class Update(val message: String) : LinkState
}

/** The runner answered with an error; its message is the runner's plain string. */
class RunnerCallException(message: String) : Exception(message)

open class RunnerOfflineException(message: String = "Not connected to your organization's host") : IOException(message)

class SignedOutException : RunnerOfflineException("Signed out. Sign in again to continue.")

/** There is no sign-in to connect with. */
class NoCredentialsException : Exception("Not signed in")

/** The socket the connection writes to. Implemented over OkHttp, or faked in tests. */
interface WireSocket {
    fun send(text: String): Boolean
    fun close()
}

/** What a socket reports. Callbacks may arrive on any thread. */
interface WireEvents {
    fun onOpen()
    fun onText(text: String)
    /** Exactly once per socket. [httpStatus] is set when the upgrade itself was refused. */
    fun onClosed(code: Int, httpStatus: Int?)
}

fun interface SocketOpener {
    /** [renew] asks for a fresh access token: the host turned the previous one away. */
    suspend fun open(events: WireEvents, renew: Boolean): WireSocket
}

/** The narrow surface the app store needs from a runner (Adapter over the wire protocol). */
interface RunnerPort {
    val link: StateFlow<LinkState>

    /**
     * Hands the connection to a new owner, or to nobody at sign-out. Nothing of the previous
     * owner survives: every pending call fails, identified ones included, and its socket is
     * dropped, so [onPush] only ever hears sockets opened afterwards by [start].
     */
    fun rebind(onPush: ((channel: String, payload: Any?) -> Unit)?)
    fun start()
    fun pause()
    fun reconnect()
    fun close()
    suspend fun call(channel: String, input: Any? = null): Any?
    /** For calls carrying their own identity (messageId): kept and resent across reconnects. */
    suspend fun callIdentified(channel: String, input: Any?): Any?
}

/**
 * The app's single runner connection (base protocol 6, JSON hello/call/result/push frames).
 * Nothing but the hello is sent until the host's own hello grants `mobile.v1`: a host without
 * it has neither the mobile call scope nor project discovery, so the app asks it for nothing
 * and says an update is needed. `bots.v1` is requested so bot workspaces and `bots:changed`
 * keep arriving; a host that does not grant it filters those out itself.
 *
 * All state is confined to one serial dispatcher; each socket's callbacks carry the
 * generation they were opened under and are ignored once a newer attempt exists.
 */
class RunnerConnection(
    private val opener: SocketOpener,
    dispatcher: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1),
    private val protocol: Int = RUNNER_PROTOCOL,
    private val retryFirstMs: Long = 500,
    private val retryMaxMs: Long = 10_000,
    private val callTimeoutMs: Long = 30_000,
) : RunnerPort {
    private val serial = dispatcher
    private val scope = CoroutineScope(SupervisorJob() + serial)
    private val state = MutableStateFlow<LinkState>(LinkState.Idle)
    override val link: StateFlow<LinkState> = state.asStateFlow()

    private class Pending(
        val frame: String,
        val identified: Boolean,
        val result: CompletableDeferred<Any?>,
    )

    private var onPush: ((String, Any?) -> Unit)? = null

    private val pending = LinkedHashMap<Long, Pending>()
    private var socket: WireSocket? = null
    private var generation = 0L
    private var openedGeneration = -1L
    private var connecting = false
    private var ready = false
    private var active = false
    private var closed = false
    private var stopped = false
    private var refused = false
    private var signedOut = false
    private val nextId = AtomicLong(1)
    private var retryMs = retryFirstMs
    private var retryJob: Job? = null

    override fun rebind(onPush: ((channel: String, payload: Any?) -> Unit)?) {
        scope.launch {
            if (closed) return@launch
            active = false
            abandonSocket()
            failAll { SignedOutException() }
            this@RunnerConnection.onPush = onPush
            // A new owner may be another host at another version: start from a clean slate.
            stopped = false
            refused = false
            signedOut = false
            retryMs = retryFirstMs
            state.value = LinkState.Idle
        }
    }

    override fun start() {
        scope.launch {
            if (closed || stopped) return@launch
            active = true
            if (socket == null && !connecting) connect()
        }
    }

    override fun pause() {
        scope.launch {
            if (closed) return@launch
            active = false
            abandonSocket()
            dropped()
            if (!signedOut && !stopped) state.value = LinkState.Paused
        }
    }

    override fun reconnect() {
        scope.launch {
            if (closed || stopped) return@launch
            active = true
            refused = false
            retryMs = retryFirstMs
            abandonSocket()
            dropped()
            connect()
        }
    }

    override fun close() {
        scope.launch {
            if (closed) return@launch
            closed = true
            active = false
            abandonSocket()
            failAll { RunnerOfflineException("The connection closed") }
            state.value = LinkState.Idle
            scope.cancel()
        }
    }

    override suspend fun call(channel: String, input: Any?): Any? = request(channel, input, identified = false)

    override suspend fun callIdentified(channel: String, input: Any?): Any? = request(channel, input, identified = true)

    private suspend fun request(channel: String, input: Any?, identified: Boolean): Any? {
        val id = nextId.getAndIncrement()
        val frame = LinkedHashMap<String, Any?>().apply {
            put("type", "call")
            put("id", id)
            put("channel", channel)
            if (input != null) put("input", input)
        }
        val call = Pending(Json.encode(frame), identified, CompletableDeferred())
        // From registration on, the call is its caller's: however the caller leaves, the call
        // leaves with it and is never sent, or resent, on its behalf afterwards.
        try {
            withContext(serial) {
                if (signedOut) throw SignedOutException()
                if (closed || stopped || (!ready && !identified)) throw RunnerOfflineException()
                pending[id] = call
                if (ready) send(call)
            }
            return if (identified) call.result.await() else withTimeout(callTimeoutMs) { call.result.await() }
        } catch (timeout: TimeoutCancellationException) {
            withContext(NonCancellable + serial) { pending.remove(id) }
            throw RunnerOfflineException("Your organization's host did not answer in time")
        } catch (cancelled: CancellationException) {
            withContext(NonCancellable + serial) { pending.remove(id) }
            throw cancelled
        }
    }

    // ---- Confined to the serial dispatcher below ------------------------------------------

    private fun send(call: Pending) {
        socket?.send(call.frame)
    }

    private fun sendHello(target: WireSocket) {
        target.send(Json.encode(mapOf("type" to "hello", "protocol" to protocol.toLong())))
    }

    private fun abandonSocket() {
        generation++
        retryJob?.cancel()
        retryJob = null
        connecting = false
        ready = false
        socket?.close()
        socket = null
    }

    private fun connect(renew: Boolean = false) {
        retryJob?.cancel()
        retryJob = null
        val attempt = ++generation
        signedOut = false
        ready = false
        connecting = true
        state.value = LinkState.Connecting
        scope.launch {
            val opened = try {
                opener.open(eventsFor(attempt), renew)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: NoCredentialsException) {
                if (attempt == generation) {
                    connecting = false
                    awaitSignIn()
                }
                return@launch
            } catch (_: Exception) {
                if (attempt == generation) {
                    connecting = false
                    retryLater()
                }
                return@launch
            }
            if (attempt != generation || !active || closed) {
                opened.close()
                return@launch
            }
            connecting = false
            socket = opened
            if (openedGeneration == attempt) sendHello(opened)
        }
    }

    private fun eventsFor(attempt: Long) = object : WireEvents {
        override fun onOpen() {
            scope.launch {
                if (attempt != generation) return@launch
                openedGeneration = attempt
                socket?.let(::sendHello)
            }
        }

        override fun onText(text: String) {
            scope.launch { if (attempt == generation) receive(text) }
        }

        override fun onClosed(code: Int, httpStatus: Int?) {
            scope.launch { if (attempt == generation) closedBy(code, httpStatus) }
        }
    }

    private fun receive(text: String) {
        if (text.length > MAX_FRAME_CHARS) {
            socket?.close()
            return
        }
        val frame = try {
            Json.parse(text).asObject()
        } catch (_: Json.JsonException) {
            null
        } ?: return
        when (frame["type"]) {
            "hello" -> {
                if (frame["protocol"] != protocol.toLong()) {
                    val theirs = frame.long("protocol") ?: 0
                    haltForUpdate(
                        LinkState.Update(
                            if (theirs > protocol) "Update Loom: this app is older than your organization's host."
                            else "Your organization's host is older than this app and needs updating."
                        )
                    )
                    return
                }
                val granted = frame.list("capabilities") ?: emptyList()
                if (MOBILE_CAPABILITY !in granted) {
                    haltForUpdate(
                        LinkState.Update("Your organization's host doesn't support Loom on mobile yet. It needs updating.")
                    )
                    return
                }
                ready = true
                refused = false
                retryMs = retryFirstMs
                // Whatever waited for a connection goes out again under its own identity.
                for (call in pending.values) send(call)
                state.value = LinkState.Connected
            }
            "push" -> frame.string("channel")?.let { channel -> onPush?.invoke(channel, frame["payload"]) }
            "result" -> {
                val id = frame.long("id") ?: return
                val call = pending.remove(id) ?: return
                if (frame["ok"] == true) call.result.complete(frame["value"])
                else call.result.completeExceptionally(RunnerCallException(frame.string("error") ?: "The request failed"))
            }
        }
    }

    private fun closedBy(code: Int, httpStatus: Int?) {
        socket = null
        ready = false
        connecting = false
        if (code == CLOSE_UPDATE_REQUIRED) {
            haltForUpdate(LinkState.Update("This app and your organization's host are different versions."))
            return
        }
        dropped()
        if (httpStatus == 401 || code == CLOSE_SIGNED_OUT) turnedAway() else retryLater()
    }

    /** Ordinary calls fail with the connection; identified ones wait for the next one. */
    private fun dropped() {
        val iterator = pending.entries.iterator()
        while (iterator.hasNext()) {
            val call = iterator.next().value
            if (call.identified) continue
            iterator.remove()
            call.result.completeExceptionally(RunnerOfflineException("The connection to your organization's host dropped"))
        }
    }

    private fun failAll(error: () -> Exception) {
        for (call in pending.values) call.result.completeExceptionally(error())
        pending.clear()
    }

    private fun haltForUpdate(next: LinkState) {
        stopped = true
        active = false
        abandonSocket()
        failAll { RunnerOfflineException("Update required") }
        state.value = next
    }

    private fun retryLater() {
        if (!active || closed || stopped) return
        state.value = LinkState.Offline("Reconnecting to your organization's host…")
        val wait = retryMs
        retryMs = (retryMs * 2).coerceAtMost(retryMaxMs)
        retryJob = scope.launch {
            delay(wait)
            if (active && socket == null && !connecting) connect()
        }
    }

    /** One fresh token is worth trying; a second refusal in a row means signed out. */
    private fun turnedAway() {
        if (refused) return awaitSignIn()
        refused = true
        connect(renew = true)
    }

    /** This sign-in is over as far as the host is concerned; its owner is told through [link]. */
    private fun awaitSignIn() {
        signedOut = true
        failAll { SignedOutException() }
        state.value = LinkState.SignedOut
    }
}
