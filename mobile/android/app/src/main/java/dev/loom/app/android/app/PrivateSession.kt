package dev.loom.app.android.app

import dev.loom.app.android.core.asObject
import dev.loom.app.android.core.long
import dev.loom.app.android.core.obj
import dev.loom.app.android.core.string
import dev.loom.app.android.runner.LinkState
import dev.loom.app.android.runner.Project
import dev.loom.app.android.runner.QuestionAnswers
import dev.loom.app.android.runner.QuestionForm
import dev.loom.app.android.runner.QuestionRequest
import dev.loom.app.android.runner.Rows
import dev.loom.app.android.runner.RunnerCallException
import dev.loom.app.android.runner.RunnerPort
import dev.loom.app.android.runner.Transcript
import dev.loom.app.android.runner.Unread
import dev.loom.app.android.runner.Workspace
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Everything one sign-in has fetched, and every request still fetching it.
 *
 * Lifetime is ownership, not bookkeeping. All work runs under this session's job, and work
 * for a workspace runs under that workspace's own child job. [dispose] (sign-out, or another
 * sign-in taking over) cancels the first; losing sight of a workspace cancels the second. A
 * cancelled request never resumes with its reply, so nothing here needs to ask "is this
 * still current?" before writing. And what a disposed session holds is unreachable: the
 * store has stopped observing [data].
 *
 * Confined to the main thread. Nothing is persisted.
 */
class PrivateSession(private val runner: RunnerPort, parent: Job) {
    private val job = SupervisorJob(parent)
    private val scope = CoroutineScope(job + Dispatchers.Main.immediate)
    private val mutable = MutableStateFlow(PrivateData())
    val data: StateFlow<PrivateData> = mutable.asStateFlow()

    private class Conversation(val workspaceId: String, val transcript: Transcript) {
        var catchingUp = false
    }

    /** One job per workspace this member has asked about; cancelled when it stops being visible. */
    private val grants = HashMap<String, CoroutineScope>()
    private val conversations = HashMap<String, Conversation>()
    private var inventoryJob: Job? = null

    private val connected: Boolean get() = runner.link.value == LinkState.Connected

    init {
        scope.launch {
            var previous: LinkState = LinkState.Idle
            runner.link.collect { link ->
                if (link == LinkState.Connected && previous != LinkState.Connected) onConnected()
                previous = link
            }
        }
    }

    fun dispose() = job.cancel()

    /** Work that only means something while [workspaceId] is visible to this member. */
    private fun launchFor(workspaceId: String, block: suspend CoroutineScope.() -> Unit): Job =
        grants.getOrPut(workspaceId) { CoroutineScope(scope.coroutineContext + SupervisorJob(job)) }.launch(block = block)

    /** A failure as a value. Cancellation is never one: it ends the caller, silently. */
    private suspend fun <T> attempt(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Exception) {
        Result.failure(error)
    }

    private fun onConnected() {
        reloadInventory()
        for (sessionId in conversations.keys.toList()) catchUp(sessionId)
        for (screen in data.value.stack) when (screen) {
            is Screen.Workspace -> refreshWorkspace(screen.workspaceId)
            is Screen.Conversation -> loadQueue(screen.workspaceId, screen.sessionId)
            else -> Unit
        }
    }

    // ---- Navigation ---------------------------------------------------------------------

    /** Selecting history replaces the current chat; details still use the ordinary back stack. */
    fun selectConversation(workspaceId: String, sessionId: String) {
        if (data.value.session(workspaceId, sessionId) == null) return
        val destination = Screen.Conversation(workspaceId, sessionId)
        if (data.value.stack.last() == destination) return
        while (pop()) { /* Release the previous screen's scoped content. */ }
        push(destination)
    }

    fun push(screen: Screen) {
        mutable.update { it.copy(stack = it.stack + screen) }
        when (screen) {
            is Screen.Workspace -> refreshWorkspace(screen.workspaceId)
            is Screen.Conversation -> openConversation(screen.workspaceId, screen.sessionId)
            is Screen.Files -> loadDir(screen.workspaceId, screen.path)
            is Screen.FileView -> loadFile(screen.workspaceId, screen.path)
            is Screen.Changes -> loadChanges(screen.workspaceId)
            is Screen.Diff -> loadDiff(screen.workspaceId, screen.path)
            Screen.Workspaces, Screen.Account -> Unit
        }
    }

    /** Returns false at the root so the system can finish the activity. */
    fun pop(): Boolean {
        val stack = data.value.stack
        if (stack.size <= 1) return false
        val leaving = stack.last()
        mutable.update { s ->
            val next = s.copy(stack = s.stack.dropLast(1))
            // Content of screens no longer shown is released, never cached.
            when (leaving) {
                is Screen.FileView -> next.copy(fileTexts = next.fileTexts - key(leaving.workspaceId, leaving.path))
                is Screen.Diff -> next.copy(diffs = next.diffs - key(leaving.workspaceId, leaving.path))
                is Screen.Files -> next.copy(dirs = next.dirs - key(leaving.workspaceId, leaving.path))
                else -> next
            }
        }
        if (leaving is Screen.Conversation && data.value.stack.none { it == leaving }) {
            conversations.remove(leaving.sessionId)
            mutable.update { it.copy(transcripts = it.transcripts - leaving.sessionId) }
        }
        return true
    }

    fun dismissNotice() = mutable.update { it.copy(notice = null) }

    fun setSearch(text: String) = mutable.update { it.copy(search = text.take(100)) }

    fun setShowArchived(show: Boolean) = mutable.update { it.copy(showArchived = show) }

    private fun notify(message: String) = mutable.update { it.copy(notice = message) }

    // ---- Inventory ------------------------------------------------------------------------

    private class Inventory(
        val projects: List<Project>,
        val workspaces: Map<String, List<Workspace>>,
        val activity: Pair<Long, Map<String, String>>?,
        val unread: Map<String, Unread>,
    )

    fun reloadInventory() {
        if (!connected) return
        inventoryJob?.cancel()
        mutable.update { it.copy(inventoryLoading = true) }
        inventoryJob = scope.launch {
            val inventory = attempt {
                val projects = Rows.projects(runner.call("projects:list"))
                // Its own scope: one failed listing fails the reload, not this session.
                val workspaces = coroutineScope {
                    projects.map { project ->
                        async { project.id to Rows.workspaces(runner.call("workspaces:list", mapOf("projectId" to project.id))) }
                    }.awaitAll().toMap()
                }
                Inventory(
                    projects, workspaces,
                    Rows.activity(runner.call("sessions:activity")),
                    Rows.unread(runner.call("sessions:unread")),
                )
            }.getOrElse { error ->
                // Keep what was already loaded; show the failure next to it.
                mutable.update { it.copy(inventoryLoading = false, inventoryError = message(error)) }
                return@launch
            }
            applyInventory(inventory)
            inventory.workspaces.values.flatten().filter { it.hasPower && !it.archived }.take(40)
                .forEach { loadPower(it.id) }
        }
    }

    /** Ends the work, and drops the data, of every workspace the member can no longer see. */
    private fun applyInventory(inventory: Inventory) {
        val visible = inventory.workspaces.values.flatten().map { it.id }.toSet()
        grants.keys.filter { it !in visible }.forEach { grants.remove(it)?.cancel() }
        conversations.entries.removeAll { it.value.workspaceId !in visible }
        mutable.update { s ->
            val gone = HashSet<String>()
            s.sessions.forEach { (workspaceId, loaded) ->
                if (workspaceId !in visible) (loaded as? Loadable.Ready)?.value?.forEach { gone += it.id }
            }
            s.unread.forEach { (sessionId, unread) -> if (unread.workspaceId !in visible) gone += sessionId }
            s.stack.forEach { if (it is Screen.Conversation && it.workspaceId !in visible) gone += it.sessionId }
            fun <V> Map<String, V>.keepWorkspaces() = filterKeys { it in visible }
            fun <V> Map<String, V>.keepKeyed() = filterKeys { it.substringBefore('\u0000') in visible }
            fun <V> Map<String, V>.dropSessions() = filterKeys { it !in gone }
            val stack = s.stack.takeWhile { screen -> screen.workspaceId?.let { it in visible } ?: true }
            s.copy(
                projects = inventory.projects.filter { (inventory.workspaces[it.id] ?: emptyList()).isNotEmpty() },
                workspaces = inventory.workspaces.filterValues { it.isNotEmpty() },
                activity = inventory.activity?.second ?: s.activity,
                activityRevision = inventory.activity?.first ?: s.activityRevision,
                unread = inventory.unread,
                inventoryLoaded = true,
                inventoryLoading = false,
                inventoryError = null,
                power = s.power.keepWorkspaces(),
                powerBusy = s.powerBusy.filterTo(HashSet()) { it in visible },
                sessions = s.sessions.keepWorkspaces(),
                dirs = s.dirs.keepKeyed(),
                fileTexts = s.fileTexts.keepKeyed(),
                changes = s.changes.keepWorkspaces(),
                diffs = s.diffs.keepKeyed(),
                transcripts = s.transcripts.dropSessions(),
                drafts = s.drafts.dropSessions(),
                outgoing = s.outgoing.dropSessions(),
                queues = s.queues.dropSessions(),
                cancelling = s.cancelling.filterTo(HashSet()) { it !in gone },
                stack = stack.ifEmpty { listOf(Screen.Workspaces) },
                notice = if (stack.size < s.stack.size) "That workspace is no longer available to you." else s.notice,
            )
        }
    }

    fun refreshWorkspace(workspaceId: String) {
        loadSessions(workspaceId)
        if (data.value.workspace(workspaceId)?.hasPower == true) loadPower(workspaceId)
    }

    fun loadSessions(workspaceId: String) {
        if (data.value.workspace(workspaceId) == null) return
        if (!connected) return
        if (data.value.sessions[workspaceId] !is Loadable.Ready) {
            mutable.update { it.copy(sessions = it.sessions + (workspaceId to Loadable.Loading)) }
        }
        launchFor(workspaceId) {
            val result = attempt {
                Rows.sessions(runner.call("sessions:list", mapOf("workspaceId" to workspaceId)))
                    .filter { it.closedAt == null }
                    .sortedByDescending { it.createdAt }
            }.fold({ Loadable.Ready(it) }) { error ->
                handleNotFound(error)
                // A refresh that fails keeps the list already on screen.
                if (data.value.sessions[workspaceId] is Loadable.Ready) return@launchFor
                Loadable.Failed(message(error))
            }
            mutable.update { it.copy(sessions = it.sessions + (workspaceId to result)) }
        }
    }

    private fun loadPower(workspaceId: String) {
        if (!connected) return
        launchFor(workspaceId) {
            val power = attempt { Rows.power(runner.call("workspaces:power", mapOf("workspaceId" to workspaceId))) }
                .getOrNull() ?: return@launchFor
            mutable.update { it.copy(power = it.power + (workspaceId to power)) }
        }
    }

    fun setPower(workspaceId: String, start: Boolean) {
        val workspace = data.value.workspace(workspaceId) ?: return
        if (!workspace.canControl || workspaceId in data.value.powerBusy) return
        mutable.update { it.copy(powerBusy = it.powerBusy + workspaceId) }
        launchFor(workspaceId) {
            val result = attempt {
                Rows.power(runner.call(if (start) "workspaces:start" else "workspaces:stop", mapOf("workspaceId" to workspaceId)))
            }
            mutable.update { s ->
                val power = result.getOrNull()
                s.copy(powerBusy = s.powerBusy - workspaceId, power = if (power == null) s.power else s.power + (workspaceId to power))
            }
            result.exceptionOrNull()?.let { error ->
                notify((if (start) "Couldn't start: " else "Couldn't stop: ") + message(error))
                handleNotFound(error)
            }
        }
    }

    // ---- Conversation ---------------------------------------------------------------------

    private fun openConversation(workspaceId: String, sessionId: String) {
        if (!conversations.containsKey(sessionId)) {
            conversations[sessionId] = Conversation(workspaceId, Transcript(sessionId))
            mutable.update { it.copy(transcripts = it.transcripts + (sessionId to TranscriptView())) }
        }
        catchUp(sessionId)
        loadQueue(workspaceId, sessionId)
    }

    private fun publish(transcript: Transcript, error: String? = null) {
        mutable.update {
            it.copy(
                transcripts = it.transcripts + (
                    transcript.sessionId to TranscriptView(
                        transcript.items, loading = false, error, transcript.runningTurn, transcript.cursor
                    )
                    )
            )
        }
    }

    /** Fetches everything after the cursor; pushes arriving meanwhile are buffered, not lost. */
    private fun catchUp(sessionId: String) {
        val conversation = conversations[sessionId] ?: return
        if (!connected || conversation.catchingUp) return
        conversation.catchingUp = true
        val transcript = conversation.transcript
        launchFor(conversation.workspaceId) {
            val result = attempt {
                var rounds = 0
                do {
                    val before = transcript.cursor
                    transcript.acceptReplay(
                        runner.call("sessions:eventsAfter", mapOf("sessionId" to sessionId, "afterSeq" to before))
                    )
                    rounds++
                } while (transcript.hasGap && transcript.cursor > before && rounds < 5)
            }
            conversation.catchingUp = false
            // The screen was left meanwhile: its transcript is released, not republished.
            if (conversations[sessionId] !== conversation) return@launchFor
            publish(transcript, error = result.exceptionOrNull()?.let(::message))
            result.fold({ markRead(sessionId) }, ::handleNotFound)
        }
    }

    private fun loadQueue(workspaceId: String, sessionId: String) {
        if (!connected) return
        launchFor(workspaceId) {
            val queue = attempt { Rows.queue(runner.call("sessions:queue", mapOf("sessionId" to sessionId))) }
                .getOrNull() ?: return@launchFor
            mutable.update { it.copy(queues = it.queues + (sessionId to queue)) }
        }
    }

    private fun markRead(sessionId: String) {
        val unread = data.value.unread[sessionId] ?: return
        val conversation = conversations[sessionId] ?: return
        if (unread.seq <= 0 || unread.seq > conversation.transcript.cursor) return
        mutable.update { it.copy(unread = it.unread - sessionId) }
        launchFor(conversation.workspaceId) {
            attempt { runner.call("sessions:markRead", mapOf("sessionId" to sessionId, "seq" to unread.seq)) }
        }
    }

    fun setDraft(sessionId: String, text: String) {
        mutable.update { s ->
            val outgoing = s.outgoing[sessionId]
            // Editing a failed message gives it a new identity; an in-flight one keeps its own.
            val nextOutgoing = if (outgoing != null && !outgoing.inFlight && outgoing.text != text) s.outgoing - sessionId else s.outgoing
            s.copy(drafts = s.drafts + (sessionId to text.take(200_000)), outgoing = nextOutgoing)
        }
    }

    fun send(workspaceId: String, sessionId: String) {
        val s = data.value
        val text = s.drafts[sessionId] ?: return
        val workspace = s.workspace(workspaceId) ?: return
        if (text.isBlank() || !connected || !workspace.canControl) return
        val previous = s.outgoing[sessionId]
        if (previous?.inFlight == true) return
        // A retry of the same unchanged text keeps the identity the runner may already have run.
        val messageId = previous?.takeIf { it.text == text }?.messageId ?: UUID.randomUUID().toString()
        mutable.update { it.copy(outgoing = it.outgoing + (sessionId to Outgoing(text, messageId, true, null))) }
        launchFor(workspaceId) {
            attempt {
                runner.callIdentified(
                    "sessions:send",
                    mapOf("sessionId" to sessionId, "text" to text, "attachments" to emptyList<String>(), "messageId" to messageId),
                )
            }.fold({
                mutable.update {
                    it.copy(
                        outgoing = it.outgoing - sessionId,
                        drafts = if (it.drafts[sessionId] == text) it.drafts - sessionId else it.drafts,
                    )
                }
            }) { error ->
                // The draft stays; the identity stays for a retry of the same text.
                mutable.update {
                    if (it.outgoing[sessionId]?.messageId != messageId) it
                    else it.copy(outgoing = it.outgoing + (sessionId to Outgoing(text, messageId, false, message(error))))
                }
                handleNotFound(error)
            }
        }
    }

    fun cancelTurn(workspaceId: String, sessionId: String) {
        val workspace = data.value.workspace(workspaceId) ?: return
        if (!workspace.canControl || sessionId in data.value.cancelling) return
        mutable.update { it.copy(cancelling = it.cancelling + sessionId) }
        launchFor(workspaceId) {
            val result = attempt { runner.call("sessions:cancel", mapOf("sessionId" to sessionId)) }
            mutable.update { it.copy(cancelling = it.cancelling - sessionId) }
            result.exceptionOrNull()?.let { notify("Couldn't stop the turn: ${message(it)}") }
        }
    }

    /** Returns false when the answers are incomplete. Never auto-retried. */
    fun answer(workspaceId: String, sessionId: String, request: QuestionRequest, forms: Map<String, QuestionForm>): Boolean {
        val workspace = data.value.workspace(workspaceId) ?: return false
        if (!workspace.canControl || !connected) return false
        val answers = QuestionAnswers.build(request, forms) ?: return false
        val id = request.requestId
        if (id in data.value.answering) return false
        mutable.update { it.copy(answering = it.answering + id) }
        launchFor(workspaceId) {
            val result = attempt {
                runner.call(
                    "sessions:answerQuestion",
                    mapOf("sessionId" to sessionId, "answer" to mapOf("requestId" to id, "answers" to answers)),
                )
            }
            mutable.update {
                it.copy(answering = it.answering - id, submitted = if (result.isSuccess) it.submitted + id else it.submitted)
            }
            result.exceptionOrNull()?.let { notify("Couldn't send the answer: ${message(it)}") }
        }
        return true
    }

    // ---- Files and changes ------------------------------------------------------------------

    fun loadDir(workspaceId: String, path: String) = load(
        workspaceId, { it.dirs }, { s, v -> s.copy(dirs = s.dirs + (key(workspaceId, path) to v)) }, key(workspaceId, path),
    ) {
        Rows.files(runner.call("files:listDir", mapOf("workspaceId" to workspaceId, "path" to path.ifEmpty { "." })))
    }

    fun loadFile(workspaceId: String, path: String) = load(
        workspaceId, { it.fileTexts }, { s, v -> s.copy(fileTexts = s.fileTexts + (key(workspaceId, path) to v)) }, key(workspaceId, path),
    ) {
        Rows.fileText(runner.call("files:read", mapOf("workspaceId" to workspaceId, "path" to path)))
            ?: throw RunnerCallException("This file can't be shown")
    }

    fun loadChanges(workspaceId: String) = load(
        workspaceId, { it.changes }, { s, v -> s.copy(changes = s.changes + (workspaceId to v)) }, workspaceId,
    ) {
        Rows.changes(runner.call("git:status", mapOf("workspaceId" to workspaceId)))
    }

    fun loadDiff(workspaceId: String, path: String) = load(
        workspaceId, { it.diffs }, { s, v -> s.copy(diffs = s.diffs + (key(workspaceId, path) to v)) }, key(workspaceId, path),
    ) {
        runner.call("git:diff", mapOf("workspaceId" to workspaceId, "path" to path)) as? String ?: ""
    }

    private fun <T> load(
        workspaceId: String,
        read: (PrivateData) -> Map<String, Loadable<T>>,
        write: (PrivateData, Loadable<T>) -> PrivateData,
        id: String,
        fetch: suspend () -> T,
    ) {
        if (!connected) {
            if (read(data.value)[id] == null) mutable.update { write(it, Loadable.Failed("Not connected")) }
            return
        }
        mutable.update { write(it, Loadable.Loading) }
        launchFor(workspaceId) {
            val result: Loadable<T> = attempt { fetch() }.fold({ Loadable.Ready(it) }) { error ->
                handleNotFound(error)
                Loadable.Failed(message(error))
            }
            mutable.update { write(it, result) }
        }
    }

    // ---- Pushes ---------------------------------------------------------------------------

    /** From the connection, on its thread. A disposed session's scope drops it. */
    fun receive(channel: String, payload: Any?) {
        scope.launch { onPush(channel, payload) }
    }

    private fun onPush(channel: String, payload: Any?) {
        val body = payload.asObject() ?: return
        when (channel) {
            "session:event" -> {
                val sessionId = body.string("sessionId") ?: return
                body.obj("unread")?.let(Rows::unreadRow)?.let { unread ->
                    mutable.update { it.copy(unread = it.unread + (sessionId to unread)) }
                }
                val transcript = conversations[sessionId]?.transcript ?: return
                val seq = body.long("seq") ?: return
                if (transcript.accept(seq, body["event"])) publish(transcript)
                if (transcript.hasGap) catchUp(sessionId) else markRead(sessionId)
            }
            "session:activity" -> {
                val (revision, bySession) = Rows.activity(body) ?: return
                mutable.update {
                    if (revision < it.activityRevision) it else it.copy(activity = bySession, activityRevision = revision)
                }
            }
            "workspaces:powerChanged" -> {
                val workspaceId = body.string("workspaceId") ?: return
                val power = Rows.power(body) ?: return
                mutable.update { it.copy(power = it.power + (workspaceId to power)) }
            }
            "workspace:state" -> {
                val workspaceId = body.string("workspaceId") ?: return
                val next = body.string("state")
                val name = body.string("name")
                mutable.update { s ->
                    s.copy(workspaces = s.workspaces.mapValues { (_, list) ->
                        list.map { w ->
                            if (w.id != workspaceId) w else w.copy(state = next ?: w.state, name = name ?: w.name)
                        }
                    })
                }
            }
            "session:queue" -> {
                val sessionId = body.string("sessionId") ?: return
                mutable.update { it.copy(queues = it.queues + (sessionId to Rows.queue(body["items"]))) }
            }
            "session:title" -> {
                val sessionId = body.string("sessionId") ?: return
                val title = body.string("title")?.takeIf { it.isNotBlank() } ?: return
                mutable.update { s ->
                    s.copy(sessions = s.sessions.mapValues { (_, loaded) ->
                        if (loaded !is Loadable.Ready) loaded
                        else Loadable.Ready(loaded.value.map { if (it.id == sessionId) it.copy(title = title) else it })
                    })
                }
            }
            "bots:changed" -> if (body["accessChanged"] == true) reloadInventory()
        }
    }

    // ---- Helpers --------------------------------------------------------------------------

    /** "not found" means the thing is gone or no longer ours: refresh what is visible. */
    private fun handleNotFound(error: Throwable) {
        if (error is RunnerCallException && error.message?.endsWith("was not found") == true) reloadInventory()
    }

    private fun message(error: Throwable): String = when (error) {
        is RunnerCallException -> error.message ?: "The host refused the request"
        else -> error.message ?: "Something went wrong"
    }.take(300)
}
