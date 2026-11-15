package dev.loom.app.android.app

import dev.loom.app.android.auth.AuthPort
import dev.loom.app.android.auth.AuthState
import dev.loom.app.android.core.Json
import dev.loom.app.android.core.asObject
import dev.loom.app.android.runner.LinkState
import dev.loom.app.android.runner.RunnerOfflineException
import dev.loom.app.android.runner.RunnerPort
import dev.loom.app.android.runner.SignedOutException
import dev.loom.app.android.runner.TranscriptItem
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Private data has the lifetime of the sign-in, and of the grant, it was fetched under. The
 * runner here answers only when the test says so, so replies can be made to arrive late.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AppStorePrivacyTest {
    private class FakeAuth : AuthPort {
        override val state = MutableStateFlow<AuthState>(AuthState.SignedOut())
        private var sessions = 0L
        fun signIn(email: String) {
            state.value = AuthState.SignedIn("loom.example.com", email, ++sessions)
        }
        override suspend fun begin(originText: String, emailText: String) = Result.failure<String>(IllegalStateException())
        override suspend fun cancelSignIn() = Unit
        override suspend fun complete(rawCallback: String?) = Unit
        override suspend fun signOut() {
            state.value = AuthState.SignedOut()
        }
        override suspend fun endSession(ended: AuthState.SignedIn, notice: String) {
            if (state.value == ended) state.value = AuthState.SignedOut(notice)
        }
    }

    private class Call(val channel: String, val input: Map<String, Any?>) {
        val reply = CompletableDeferred<Any?>()
    }

    private class FakeRunner : RunnerPort {
        override val link = MutableStateFlow<LinkState>(LinkState.Idle)
        var onPush: ((String, Any?) -> Unit)? = null
        val calls = ArrayList<Call>()
        /**
         * The real connection fails whatever is pending when it changes hands. A test may
         * instead leave those replies in flight, as when one is already on its way back.
         */
        var failPendingAtHandOver = false

        override fun rebind(onPush: ((channel: String, payload: Any?) -> Unit)?) {
            if (failPendingAtHandOver) pending().forEach { it.reply.completeExceptionally(SignedOutException()) }
            this.onPush = onPush
            link.value = LinkState.Idle
        }
        override fun start() { link.value = LinkState.Connected }
        override fun pause() { link.value = LinkState.Paused }
        override fun reconnect() { link.value = LinkState.Connected }
        override fun close() = Unit

        override suspend fun call(channel: String, input: Any?): Any? =
            Call(channel, input.asObject() ?: emptyMap()).also { calls += it }.reply.await()

        override suspend fun callIdentified(channel: String, input: Any?): Any? = call(channel, input)

        fun pending() = calls.filter { !it.reply.isCompleted }

        fun answer(channel: String, json: String, where: (Map<String, Any?>) -> Boolean = { true }) {
            val call = pending().firstOrNull { it.channel == channel && where(it.input) }
                ?: error("no pending $channel; pending: ${pending().map { it.channel }}")
            call.reply.complete(Json.parse(json))
        }

        fun answerAll(channel: String, json: String) {
            while (pending().any { it.channel == channel }) answer(channel, json)
        }

        fun push(channel: String, json: String) = onPush!!.invoke(channel, Json.parse(json))
    }

    private val auth = FakeAuth()
    private val runner = FakeRunner()
    private lateinit var store: AppStore

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        store = AppStore(auth, runner)
        store.foreground()
    }

    @After
    fun tearDown() {
        store.dispose()
        Dispatchers.resetMain()
    }

    private val state get() = store.state.value.data

    /** Everything private the store still holds, by name. Empty means nothing is left. */
    private fun privateLeft(): List<String> = with(state) {
        listOfNotNull(
            "stack".takeIf { stack != listOf<Screen>(Screen.Workspaces) },
            "projects".takeIf { projects.isNotEmpty() },
            "workspaces".takeIf { workspaces.isNotEmpty() },
            "power".takeIf { power.isNotEmpty() || powerBusy.isNotEmpty() },
            "sessions".takeIf { sessions.isNotEmpty() },
            "activity".takeIf { activity.isNotEmpty() },
            "unread".takeIf { unread.isNotEmpty() },
            "queues".takeIf { queues.isNotEmpty() },
            "transcripts".takeIf { transcripts.isNotEmpty() },
            "drafts".takeIf { drafts.isNotEmpty() || outgoing.isNotEmpty() },
            "questions".takeIf { answering.isNotEmpty() || submitted.isNotEmpty() || cancelling.isNotEmpty() },
            "dirs".takeIf { dirs.isNotEmpty() },
            "fileTexts".takeIf { fileTexts.isNotEmpty() },
            "changes".takeIf { changes.isNotEmpty() },
            "diffs".takeIf { diffs.isNotEmpty() },
            "notice".takeIf { notice != null },
            "inventory".takeIf { inventoryLoaded || inventoryLoading || inventoryError != null },
        )
    }

    private fun workspace(id: String, project: String, bot: Boolean = false) =
        """{"id":"$id","projectId":"$project","name":"$id","branch":"b","archived":false,"state":"ready","runtime":"container","ownerId":"u"""" +
            (if (bot) ""","bot":{"id":"bot-1","access":"control"}""" else "") + "}"

    /** Answers one inventory reload: which workspaces the caller may currently see. */
    private fun answerInventory(vararg workspaces: Pair<String, Boolean>) {
        runner.answer("projects:list", if (workspaces.isEmpty()) "[]" else """[{"id":"p1","name":"loom"}]""")
        if (workspaces.isNotEmpty()) {
            runner.answer("workspaces:list", workspaces.joinToString(",", "[", "]") { (id, bot) -> workspace(id, "p1", bot) })
        }
        runner.answer("sessions:activity", """{"revision":1,"bySession":{}}""")
        runner.answer("sessions:unread", "{}")
        runner.answerAll("workspaces:power", """{"state":"running","error":null}""")
    }

    private fun session(id: String, workspace: String) =
        """[{"id":"$id","workspaceId":"$workspace","backend":"claude","model":"m","effort":"high","title":"Secret plan","createdAt":1,"closedAt":null}]"""

    private val events = """[{"seq":1,"event":{"type":"user.text","turnId":"t","text":"the private prompt"}}]"""

    /** Opens every kind of private screen on [workspace], leaving each request unanswered. */
    private fun openEverything(workspace: String, session: String) {
        store.push(Screen.Workspace(workspace))
        store.push(Screen.Conversation(workspace, session))
        store.push(Screen.Files(workspace, ""))
        store.push(Screen.FileView(workspace, "src/secret.kt"))
        store.push(Screen.Changes(workspace))
        store.push(Screen.Diff(workspace, "src/secret.kt"))
    }

    /** The host's answers to everything [openEverything] asked, delivered whenever the test likes. */
    private fun answerEverything() {
        for (call in runner.pending()) {
            call.reply.complete(
                Json.parse(
                    when (call.channel) {
                        "sessions:list" -> session("s1", call.input["workspaceId"] as String)
                        "sessions:eventsAfter" -> events
                        "sessions:queue" -> """[{"id":"q1","text":"queued private text"}]"""
                        "files:listDir" -> """[{"name":"secret.kt","path":"src/secret.kt","kind":"file"}]"""
                        "files:read" -> """{"text":"val apiKey = 1","language":"kotlin"}"""
                        "git:status" -> """[{"path":"src/secret.kt","status":"modified","staged":false,"unstaged":true}]"""
                        "git:diff" -> "\"+val apiKey = 1\""
                        "workspaces:power", "workspaces:start" -> """{"state":"running","error":null}"""
                        "projects:list" -> """[{"id":"p1","name":"loom"}]"""
                        "workspaces:list" -> "[" + workspace("w1", "p1") + "]"
                        "sessions:activity" -> """{"revision":9,"bySession":{"s1":"w1"}}"""
                        "sessions:unread" -> """{"s1":{"workspaceId":"w1","eventId":1,"seq":1}}"""
                        else -> "null"
                    }
                )
            )
        }
    }

    @Test
    fun aSignedInMemberSeesWhatTheHostAnswers() {
        auth.signIn("a@example.com")
        answerInventory("w1" to false)
        openEverything("w1", "s1")
        store.setDraft("s1", "draft text")
        answerEverything()

        assertEquals(listOf("w1"), state.allWorkspaces.map { it.id })
        assertEquals("Secret plan", state.session("w1", "s1")?.title)
        assertEquals("the private prompt", (state.transcripts["s1"]?.items?.single() as TranscriptItem.User).text)
        assertTrue(state.fileTexts.values.single() is Loadable.Ready)
        assertTrue(state.diffs.values.single() is Loadable.Ready)
        assertTrue(state.changes["w1"] is Loadable.Ready)
        assertEquals("draft text", state.drafts["s1"])

        runner.push("session:event", """{"workspaceId":"w1","sessionId":"s1","seq":2,"event":{"type":"text.done","turnId":"t","text":"reply"}}""")
        assertEquals(2, state.transcripts["s1"]?.items?.size)
    }

    @Test
    fun aFailedInventoryRequestIsShownNextToWhatWasLoadedAndNeverThrown() {
        val uncaught = ArrayList<Throwable>()
        val thread = Thread.currentThread()
        val previous = thread.uncaughtExceptionHandler
        thread.setUncaughtExceptionHandler { _, error -> uncaught += error }
        try {
            auth.signIn("a@example.com")
            answerInventory("w1" to false)
            store.reloadInventory()
            runner.answer("projects:list", """[{"id":"p1","name":"loom"}]""")
            // The connection drops while the per-project requests are out.
            runner.pending().single { it.channel == "workspaces:list" }.reply.completeExceptionally(RunnerOfflineException())
        } finally {
            thread.uncaughtExceptionHandler = previous
        }
        assertEquals("a dropped request must not crash the app", emptyList<Throwable>(), uncaught)
        assertEquals("Not connected to your organization's host", state.inventoryError)
        assertEquals(listOf("w1"), state.allWorkspaces.map { it.id })
    }

    @Test
    fun repliesArrivingAfterSignOutCannotBringPrivateDataBack() {
        auth.signIn("a@example.com")
        answerInventory("w1" to false)
        openEverything("w1", "s1")
        store.setPower("w1", start = true)
        store.reloadInventory()

        store.signOut()
        assertEquals(emptyList<String>(), privateLeft())
        answerEverything() // Every reply the old sign-in was waiting for arrives now.
        assertEquals(emptyList<String>(), privateLeft())
    }

    @Test
    fun signOutLeavesNoResidueWhenPendingCallsFailTheWayTheRealConnectionFailsThem() {
        runner.failPendingAtHandOver = true
        auth.signIn("a@example.com")
        answerInventory("w1" to false)
        openEverything("w1", "s1")
        store.setPower("w1", start = true)
        store.cancelTurn("w1", "s1")

        store.signOut()
        assertEquals("cancelled work must not report itself as a failure", emptyList<String>(), privateLeft())
    }

    @Test
    fun thePreviousAccountsRepliesCannotAppearInTheNextAccount() {
        auth.signIn("a@example.com")
        answerInventory("w1" to false)
        openEverything("w1", "s1")
        val before = runner.pending()

        store.signOut()
        auth.signIn("b@example.com")
        // B's own inventory request is now pending next to A's unanswered ones.
        val mine = runner.pending() - before.toSet()
        assertEquals(listOf("projects:list"), mine.map { it.channel })

        before.forEach { call ->
            call.reply.complete(
                Json.parse(
                    when (call.channel) {
                        "sessions:list" -> session("s1", "w1")
                        "sessions:eventsAfter" -> events
                        "files:read" -> """{"text":"val apiKey = 1","language":"kotlin"}"""
                        "git:diff" -> "\"+val apiKey = 1\""
                        else -> "[]"
                    }
                )
            )
        }
        assertEquals("account A's replies must not land in account B's state", emptyList<String>(), privateLeft() - "inventory")

        answerInventory("w9" to false)
        assertEquals(listOf("w9"), state.allWorkspaces.map { it.id })
        assertEquals(emptyList<String>(), privateLeft() - listOf("inventory", "projects", "workspaces", "power"))
    }

    @Test
    fun aPushStillOnItsWayToThePreviousSignInCannotReachTheNextOne() {
        auth.signIn("a@example.com")
        answerInventory("w1" to false)
        val toA = runner.onPush!!
        store.signOut()
        assertNull("the connection is handed to nobody at sign-out", runner.onPush)

        auth.signIn("b@example.com")
        answerInventory("w9" to false)
        toA("session:queue", Json.parse("""{"sessionId":"s1","items":[{"id":"q","text":"A's queued text"}]}"""))
        toA("workspaces:powerChanged", Json.parse("""{"workspaceId":"w1","state":"stopped","error":null}"""))
        assertEquals(emptyMap<String, Any>(), state.queues)
        assertEquals(setOf("w9"), state.power.keys)
    }

    @Test
    fun workEndedBySignOutAsksTheHostForNothingMore() {
        runner.failPendingAtHandOver = true
        auth.signIn("a@example.com")
        answerInventory("w1" to false)
        openEverything("w1", "s1")
        val asked = runner.calls.size
        store.signOut()
        // The old store reacted to its own failures by reloading; ended work must simply stop.
        assertEquals(asked, runner.calls.size)
        assertTrue(runner.pending().isEmpty())
    }

    @Test
    fun aHostRefusalEndsOnlyTheSignInItWasAbout() {
        auth.signIn("a@example.com")
        answerInventory("w1" to false)
        runner.link.value = LinkState.SignedOut
        assertTrue((auth.state.value as AuthState.SignedOut).notice!!.contains("no longer accepts"))
        assertEquals(emptyList<String>(), privateLeft())
    }

    @Test
    fun dataOfARevokedBotGrantCannotReappearFromRepliesAlreadyInFlight() {
        auth.signIn("a@example.com")
        answerInventory("w1" to false, "bot-w" to true)
        store.push(Screen.Workspace("w1"))
        runner.answer("sessions:list", session("s1", "w1"))
        runner.answerAll("workspaces:power", """{"state":"running","error":null}""")
        openEverything("bot-w", "bot-s")
        store.setPower("bot-w", start = true)

        // The grant is removed while those requests are in flight.
        runner.push("bots:changed", """{"accessChanged":true}""")
        answerInventory("w1" to false)
        assertNull(state.workspace("bot-w"))
        assertEquals(listOf(Screen.Workspaces, Screen.Workspace("w1")), state.stack)

        answerEverything()
        val mentionsBot = { key: String -> key.startsWith("bot-") }
        assertEquals(emptyList<String>(), listOf(
            state.sessions.keys, state.transcripts.keys, state.queues.keys, state.dirs.keys, state.fileTexts.keys,
            state.changes.keys, state.diffs.keys, state.power.keys, state.powerBusy, state.unread.keys,
        ).flatten().filter(mentionsBot))
        assertNull("revoked work must not surface an error either", state.notice?.takeIf { it != "That workspace is no longer available to you." })
        // What the member still has is untouched.
        assertEquals("Secret plan", state.session("w1", "s1")?.title)
    }
}
