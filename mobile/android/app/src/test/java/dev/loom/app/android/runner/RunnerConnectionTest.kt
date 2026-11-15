package dev.loom.app.android.runner

import dev.loom.app.android.core.Json
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/** Exercises the real connection state machine against a scripted runner socket. */
class RunnerConnectionTest {
    private class FakeSocket(val events: WireEvents) : WireSocket {
        val sent = CopyOnWriteArrayList<String>()
        @Volatile var closed = false
        override fun send(text: String): Boolean { sent += text; return !closed }
        override fun close() { closed = true }
        @Suppress("UNCHECKED_CAST")
        fun frames() = sent.map { Json.parse(it) as Map<String, Any?> }
    }

    private val sockets = CopyOnWriteArrayList<FakeSocket>()
    private val renewals = AtomicInteger()
    private val pushes = CopyOnWriteArrayList<Pair<String, Any?>>()
    private var signedIn = true
    private val connection = RunnerConnection(
        opener = SocketOpener { events, renew ->
            if (!signedIn) throw NoCredentialsException()
            if (renew) renewals.incrementAndGet()
            FakeSocket(events).also { sockets += it }
        },
        dispatcher = Dispatchers.Default.limitedParallelism(1),
        retryFirstMs = 10,
        retryMaxMs = 20,
        callTimeoutMs = 2_000,
    ).also { it.rebind { channel, payload -> pushes += channel to payload } }

    @After fun tearDown() = connection.close()

    private fun eventually(block: () -> Boolean) = runBlocking {
        withTimeout(3_000) { while (!block()) delay(5) }
    }

    private fun socket(n: Int): FakeSocket { eventually { sockets.size > n }; return sockets[n] }

    private fun handshake(n: Int): FakeSocket {
        val s = socket(n)
        s.events.onOpen()
        eventually { s.sent.isNotEmpty() }
        assertEquals(mapOf("type" to "hello", "protocol" to 6L), s.frames().first())
        s.events.onText("""{"type":"hello","protocol":6,"capabilities":["bots.v1","mobile.v1"]}""")
        eventually { connection.link.value == LinkState.Connected }
        return s
    }

    @Test
    fun routesResultsErrorsAndPushes() = runBlocking {
        connection.start()
        val s = handshake(0)
        val ping = async { connection.call("app:ping") }
        eventually { s.sent.size == 2 }
        val call = s.frames()[1]
        assertEquals("call", call["type"])
        assertEquals("app:ping", call["channel"])
        s.events.onText("""{"type":"result","id":${call["id"]},"ok":true,"value":"pong"}""")
        assertEquals("pong", ping.await())

        val failing = async { runCatching { connection.call("workspaces:power", mapOf("workspaceId" to "w")) } }
        eventually { s.sent.size == 3 }
        s.events.onText("""{"type":"result","id":${s.frames()[2]["id"]},"ok":false,"error":"workspace w was not found"}""")
        val error = failing.await().exceptionOrNull()
        assertTrue(error is RunnerCallException)
        assertEquals("workspace w was not found", error!!.message)

        s.events.onText("""{"type":"push","channel":"session:activity","payload":{"revision":3,"bySession":{}}}""")
        eventually { pushes.isNotEmpty() }
        assertEquals("session:activity", pushes.single().first)
    }

    @Test
    fun protocolMismatchRequiresUpdateAndStopsReconnecting() {
        connection.start()
        val s = socket(0)
        s.events.onOpen()
        s.events.onText("""{"type":"hello","protocol":7,"capabilities":["bots.v1","mobile.v1"]}""")
        eventually { connection.link.value is LinkState.Update }
        runBlocking { delay(100) }
        assertEquals(1, sockets.size)
    }

    @Test
    fun aHostThatDoesNotAdvertiseMobileSupportGetsNoCallAtAll() = runBlocking {
        for (hello in listOf(
            """{"type":"hello","protocol":6,"capabilities":["bots.v1","subscriptions.v1"]}""",
            """{"type":"hello","protocol":6,"capabilities":[]}""",
            """{"type":"hello","protocol":6}""",
            """{"type":"hello","protocol":6,"capabilities":"mobile.v1"}""",
            """{"type":"hello","protocol":6,"capabilities":["mobile.v10"]}""",
        )) {
            connection.rebind { _, _ -> }
            connection.start()
            val index = sockets.size
            val s = socket(index)
            // A message typed while offline is waiting for exactly this connection.
            val waiting = async {
                runCatching { connection.callIdentified("sessions:send", mapOf("sessionId" to "s", "text" to "hi", "messageId" to "m")) }
            }
            delay(20)
            s.events.onOpen()
            eventually { s.sent.isNotEmpty() }
            s.events.onText(hello)
            eventually { connection.link.value is LinkState.Update }
            assertTrue(hello, waiting.await().exceptionOrNull() is RunnerOfflineException)
            assertTrue(runCatching { connection.call("projects:list") }.exceptionOrNull() is RunnerOfflineException)
            delay(60)
            assertEquals("only the hello may ever be sent: $hello", listOf("hello"), s.frames().map { it["type"] })
            assertEquals("and it must not keep reconnecting", index + 1, sockets.size)
            assertTrue(s.closed)
        }
    }

    @Test
    fun aHostWithoutBotsStillConnectsWhenItSupportsMobile() {
        connection.start()
        val s = socket(0)
        s.events.onOpen()
        s.events.onText("""{"type":"hello","protocol":6,"capabilities":["mobile.v1"]}""")
        eventually { connection.link.value == LinkState.Connected }
    }

    @Test
    fun handOverFailsEveryPendingCallAndSilencesThePreviousSocket() = runBlocking {
        connection.start()
        val old = handshake(0)
        val ordinary = async { runCatching { connection.call("files:read", mapOf("workspaceId" to "w", "path" to "a")) } }
        val send = async {
            runCatching { connection.callIdentified("sessions:send", mapOf("sessionId" to "s", "text" to "secret", "messageId" to "m-9")) }
        }
        eventually { old.sent.size == 3 }

        val next = CopyOnWriteArrayList<Pair<String, Any?>>()
        connection.rebind { channel, payload -> next += channel to payload }
        assertTrue(ordinary.await().exceptionOrNull() is SignedOutException)
        assertTrue("an identified send belongs to its sign-in too", send.await().exceptionOrNull() is SignedOutException)
        eventually { old.closed && connection.link.value == LinkState.Idle }

        // Whatever the previous sign-in's socket still delivers reaches nobody.
        old.events.onText("""{"type":"push","channel":"session:queue","payload":{"sessionId":"s","items":[]}}""")
        old.events.onText("""{"type":"result","id":${old.frames()[1]["id"]},"ok":true,"value":{"text":"late"}}""")
        delay(50)
        assertTrue(next.isEmpty() && pushes.isEmpty())

        connection.start()
        val fresh = handshake(1)
        assertTrue("nothing of the previous owner is resent", fresh.frames().none { it["type"] == "call" })
        fresh.events.onText("""{"type":"push","channel":"session:activity","payload":{"revision":1,"bySession":{}}}""")
        eventually { next.size == 1 }
        assertTrue(pushes.isEmpty())
    }

    @Test
    fun updateCloseCodeRequiresUpdate() {
        connection.start()
        handshake(0).events.onClosed(4400, null)
        eventually { connection.link.value is LinkState.Update }
    }

    @Test
    fun disconnectFailsOrdinaryCallsButResendsIdentifiedSendWithSameMessageId() = runBlocking {
        connection.start()
        val first = handshake(0)
        val ordinary = async { runCatching { connection.call("sessions:cancel", mapOf("sessionId" to "s")) } }
        val send = async {
            connection.callIdentified(
                "sessions:send",
                mapOf("sessionId" to "s", "text" to "hi", "attachments" to emptyList<String>(), "messageId" to "m-1")
            )
        }
        eventually { first.sent.size == 3 }
        first.events.onClosed(1006, null)
        assertTrue(ordinary.await().exceptionOrNull() is RunnerOfflineException)
        val second = handshake(1)
        eventually { second.frames().any { it["channel"] == "sessions:send" } }
        val resent = second.frames().single { it["channel"] == "sessions:send" }
        @Suppress("UNCHECKED_CAST")
        assertEquals("m-1", (resent["input"] as Map<String, Any?>)["messageId"])
        assertTrue(second.frames().none { it["channel"] == "sessions:cancel" })
        second.events.onText("""{"type":"result","id":${resent["id"]},"ok":true}""")
        assertEquals(null, send.await())
    }

    @Test
    fun ordinaryCallsAreRefusedWhileOffline() = runBlocking {
        connection.start()
        socket(0)
        try {
            connection.call("app:ping")
            fail("call should fail while not connected")
        } catch (_: RunnerOfflineException) {
        }
    }

    @Test
    fun oneRefreshOnRefusalThenSignedOut() {
        connection.start()
        handshake(0).events.onClosed(4401, null)
        eventually { renewals.get() == 1 && sockets.size == 2 }
        // The refreshed token is refused too: stop and wait for a sign-in.
        socket(1).events.onClosed(-1, 401)
        eventually { connection.link.value == LinkState.SignedOut }
        runBlocking { delay(80) }
        assertEquals(2, sockets.size)
        assertEquals(1, renewals.get())
    }

    @Test
    fun missingCredentialsMeansSignedOut() {
        signedIn = false
        connection.start()
        eventually { connection.link.value == LinkState.SignedOut }
    }

    @Test
    fun staleSocketCallbacksAreFenced() = runBlocking {
        connection.start()
        val old = handshake(0)
        connection.reconnect()
        val fresh = handshake(1)
        val ping = async { connection.call("app:ping") }
        eventually { fresh.sent.size == 2 }
        val id = fresh.frames()[1]["id"]
        // The old socket's late reply and close must not resolve calls or change state.
        old.events.onText("""{"type":"result","id":$id,"ok":true,"value":"forged"}""")
        old.events.onClosed(1006, null)
        delay(50)
        assertEquals(LinkState.Connected, connection.link.value)
        fresh.events.onText("""{"type":"result","id":$id,"ok":true,"value":"pong"}""")
        assertEquals("pong", ping.await())
        assertTrue(old.closed)
    }

    @Test
    fun pauseClosesSocketAndKeepsIdentifiedSendForForeground() = runBlocking {
        connection.start()
        val first = handshake(0)
        val sent = CompletableDeferred<Any?>()
        val job = async {
            sent.complete(
                connection.callIdentified("sessions:send", mapOf("sessionId" to "s", "text" to "x", "attachments" to emptyList<String>(), "messageId" to "m-2"))
            )
        }
        eventually { first.sent.size == 2 }
        connection.pause()
        eventually { first.closed }
        eventually { connection.link.value == LinkState.Paused }
        connection.start()
        val second = handshake(1)
        eventually { second.frames().any { it["channel"] == "sessions:send" } }
        val frame = second.frames().single { it["channel"] == "sessions:send" }
        second.events.onText("""{"type":"result","id":${frame["id"]},"ok":true}""")
        job.await()
        assertTrue(sent.isCompleted)
    }
}
