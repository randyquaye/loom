package dev.loom.app.android.runner

import dev.loom.app.android.core.Json
import dev.loom.app.android.core.asObject
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.CoroutineContext

/** A call belongs to the coroutine that made it, from the moment it is registered. */
@OptIn(ExperimentalCoroutinesApi::class)
class RunnerCallCancellationTest {
    private class Socket(val events: WireEvents) : WireSocket {
        val sent = ArrayList<String>()
        override fun send(text: String): Boolean { sent += text; return true }
        override fun close() = Unit
        fun calls() = sent.mapNotNull { Json.parse(it).asObject() }.filter { it["type"] == "call" }
    }

    /** A thread that only runs when told to, so the test can stop between two hops. */
    private class Stepped : CoroutineDispatcher() {
        private val queue = ArrayDeque<Runnable>()
        override fun dispatch(context: CoroutineContext, block: Runnable) { queue += block }
        fun run() { while (queue.isNotEmpty()) queue.removeFirst().run() }
    }

    @Test
    fun aSendCancelledWhileBeingHandedToTheConnectionIsNeverResent() = runTest {
        val sockets = ArrayList<Socket>()
        val connection = RunnerConnection(
            opener = { events, _ -> Socket(events).also { sockets += it } },
            dispatcher = StandardTestDispatcher(testScheduler),
        )
        fun connect(n: Int): Socket {
            runCurrent()
            val socket = sockets[n]
            socket.events.onOpen()
            socket.events.onText("""{"type":"hello","protocol":6,"capabilities":["mobile.v1"]}""")
            runCurrent()
            assertEquals(LinkState.Connected, connection.link.value)
            return socket
        }
        connection.start()
        val first = connect(0)

        // The owner (say, a workspace whose grant is revoked) goes away at the worst moment:
        // after the connection took the message, before the owner's coroutine heard back.
        val ownerThread = Stepped()
        val owner = CoroutineScope(ownerThread).launch {
            connection.callIdentified("sessions:send", mapOf("sessionId" to "s", "text" to "hi", "messageId" to "m-1"))
        }
        ownerThread.run() // The owner asks; the connection now has the work to do.
        runCurrent() // The connection registers and sends it; the owner has not resumed yet.
        assertEquals(1, first.calls().size)
        owner.cancel()
        ownerThread.run()
        assertTrue(owner.isCancelled)
        runCurrent()

        connection.reconnect()
        val second = connect(1)
        assertEquals("a cancelled send must not go out again on the next connection", 0, second.calls().size)
        connection.close()
        runCurrent()
    }
}
