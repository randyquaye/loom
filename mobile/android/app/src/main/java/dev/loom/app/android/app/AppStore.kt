package dev.loom.app.android.app

import dev.loom.app.android.auth.AuthPort
import dev.loom.app.android.auth.AuthState
import dev.loom.app.android.runner.Change
import dev.loom.app.android.runner.FileEntry
import dev.loom.app.android.runner.FileText
import dev.loom.app.android.runner.LinkState
import dev.loom.app.android.runner.Power
import dev.loom.app.android.runner.Project
import dev.loom.app.android.runner.QuestionForm
import dev.loom.app.android.runner.QuestionRequest
import dev.loom.app.android.runner.Queued
import dev.loom.app.android.runner.RunnerPort
import dev.loom.app.android.runner.SessionInfo
import dev.loom.app.android.runner.TranscriptItem
import dev.loom.app.android.runner.Unread
import dev.loom.app.android.runner.Workspace
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface Screen {
    data object Workspaces : Screen
    data class Workspace(val workspaceId: String) : Screen
    data class Conversation(val workspaceId: String, val sessionId: String) : Screen
    data class Files(val workspaceId: String, val path: String) : Screen
    data class FileView(val workspaceId: String, val path: String) : Screen
    data class Changes(val workspaceId: String) : Screen
    data class Diff(val workspaceId: String, val path: String) : Screen
    data object Account : Screen
}

val Screen.workspaceId: String?
    get() = when (this) {
        is Screen.Workspace -> workspaceId
        is Screen.Conversation -> workspaceId
        is Screen.Files -> workspaceId
        is Screen.FileView -> workspaceId
        is Screen.Changes -> workspaceId
        is Screen.Diff -> workspaceId
        Screen.Workspaces, Screen.Account -> null
    }

sealed interface Loadable<out T> {
    data object Loading : Loadable<Nothing>
    data class Ready<T>(val value: T) : Loadable<T>
    data class Failed(val message: String) : Loadable<Nothing>
}

data class TranscriptView(
    val items: List<TranscriptItem> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
    val runningTurn: String? = null,
    val cursor: Long = 0,
)

/** A message on its way: kept with its identity until the runner acknowledges it. */
data class Outgoing(val text: String, val messageId: String, val inFlight: Boolean, val error: String?)

/** Everything fetched for one sign-in. It lives in a [PrivateSession] and dies with it. */
data class PrivateData(
    val stack: List<Screen> = listOf(Screen.Workspaces),
    val projects: List<Project> = emptyList(),
    val workspaces: Map<String, List<Workspace>> = emptyMap(),
    val inventoryLoaded: Boolean = false,
    val inventoryLoading: Boolean = false,
    val inventoryError: String? = null,
    val power: Map<String, Power> = emptyMap(),
    val powerBusy: Set<String> = emptySet(),
    val sessions: Map<String, Loadable<List<SessionInfo>>> = emptyMap(),
    val activity: Map<String, String> = emptyMap(),
    val activityRevision: Long = -1,
    val unread: Map<String, Unread> = emptyMap(),
    val queues: Map<String, List<Queued>> = emptyMap(),
    val transcripts: Map<String, TranscriptView> = emptyMap(),
    val drafts: Map<String, String> = emptyMap(),
    val outgoing: Map<String, Outgoing> = emptyMap(),
    val cancelling: Set<String> = emptySet(),
    val answering: Set<String> = emptySet(),
    val submitted: Set<String> = emptySet(),
    val dirs: Map<String, Loadable<List<FileEntry>>> = emptyMap(),
    val fileTexts: Map<String, Loadable<FileText>> = emptyMap(),
    val changes: Map<String, Loadable<List<Change>>> = emptyMap(),
    val diffs: Map<String, Loadable<String>> = emptyMap(),
    val notice: String? = null,
    val showArchived: Boolean = false,
    val search: String = "",
) {
    val allWorkspaces: List<Workspace> get() = workspaces.values.flatten()
    fun workspace(id: String): Workspace? = allWorkspaces.firstOrNull { it.id == id }
    fun session(workspaceId: String, sessionId: String): SessionInfo? =
        (sessions[workspaceId] as? Loadable.Ready)?.value?.firstOrNull { it.id == sessionId }
}

/** What the screens render: who is signed in, the link, and that sign-in's [data] (if any). */
data class AppState(
    val auth: AuthState = AuthState.Restoring,
    val link: LinkState = LinkState.Idle,
    val preview: Boolean = false,
    val data: PrivateData = PrivateData(),
) {
    val connected: Boolean get() = link == LinkState.Connected
}

internal fun key(workspaceId: String, path: String) = "$workspaceId\u0000$path"

/**
 * The one observable store (Observer via StateFlow), on the main thread. It holds nothing
 * private itself: it owns the [PrivateSession] of the current sign-in and mirrors that
 * session's data into [state]. When the sign-in ends or is replaced, the session is disposed
 * together with all of its work, the connection is handed over, and the mirror starts empty.
 */
class AppStore(
    private val auth: AuthPort,
    private val runner: RunnerPort,
    preview: Boolean = false,
) {
    private val job = SupervisorJob()
    private val scope = CoroutineScope(job + Dispatchers.Main.immediate)
    private val mutable = MutableStateFlow(AppState(preview = preview))
    val state: StateFlow<AppState> = mutable.asStateFlow()

    private class Owned(val identity: AuthState.SignedIn, val session: PrivateSession, val mirror: Job)

    private var owned: Owned? = null
    private val session: PrivateSession? get() = owned?.session
    private var foreground = false

    init {
        scope.launch {
            auth.state.collect { next ->
                val identity = next as? AuthState.SignedIn
                if (identity == owned?.identity) {
                    mutable.update { it.copy(auth = next) }
                } else {
                    disown()
                    mutable.update { it.copy(auth = next, data = PrivateData()) }
                    if (identity != null) own(identity)
                }
            }
        }
        scope.launch {
            runner.link.collect { link ->
                mutable.update { it.copy(link = link) }
                val current = owned?.identity
                if (link == LinkState.SignedOut && current != null) {
                    auth.endSession(current, "Your organization's host no longer accepts this sign-in. Sign in again.")
                }
            }
        }
    }

    /** Sign-out, revocation or a different sign-in: the old owner and all its work are gone. */
    private fun disown() {
        val ended = owned ?: return
        owned = null
        ended.mirror.cancel()
        ended.session.dispose()
        runner.rebind(null)
    }

    private fun own(identity: AuthState.SignedIn) {
        val next = PrivateSession(runner, job)
        val mirror = scope.launch { next.data.collect { data -> mutable.update { it.copy(data = data) } } }
        owned = Owned(identity, next, mirror)
        runner.rebind(next::receive)
        if (foreground) runner.start()
    }

    // ---- Lifecycle ----------------------------------------------------------------------

    fun foreground() {
        foreground = true
        if (auth.state.value is AuthState.StorageUnavailable) retryStorage()
        if (owned != null) runner.start()
    }

    fun background() {
        foreground = false
        runner.pause()
    }

    /** Person-initiated reconnect; never replays ordinary actions, only identified sends. */
    fun retry() {
        if (owned != null) runner.reconnect()
    }

    fun dispose() {
        runner.close()
        job.cancel()
    }

    // ---- Authentication -------------------------------------------------------------------

    suspend fun beginSignIn(origin: String, email: String): Result<String> = auth.begin(origin, email)

    fun retryStorage() { scope.launch { auth.retryStorage() } }

    fun cancelSignIn() {
        scope.launch { auth.cancelSignIn() }
    }

    /** What the Auth Tab returned: this attempt's redirect, or null when it closed without one. */
    fun finishSignIn(redirect: String?) {
        scope.launch { if (redirect == null) auth.cancelSignIn() else auth.complete(redirect) }
    }

    fun signOut() {
        scope.launch { auth.signOut() }
    }

    // ---- The current sign-in's private session ----------------------------------------------

    fun push(screen: Screen) { session?.push(screen) }
    fun selectConversation(workspaceId: String, sessionId: String) { session?.selectConversation(workspaceId, sessionId) }
    fun loadSessions(workspaceId: String) { session?.loadSessions(workspaceId) }
    fun pop(): Boolean = session?.pop() ?: false
    fun dismissNotice() { session?.dismissNotice() }
    fun setSearch(text: String) { session?.setSearch(text) }
    fun setShowArchived(show: Boolean) { session?.setShowArchived(show) }
    fun reloadInventory() { session?.reloadInventory() }
    fun refreshWorkspace(workspaceId: String) { session?.refreshWorkspace(workspaceId) }
    fun setPower(workspaceId: String, start: Boolean) { session?.setPower(workspaceId, start) }
    fun setDraft(sessionId: String, text: String) { session?.setDraft(sessionId, text) }
    fun send(workspaceId: String, sessionId: String) { session?.send(workspaceId, sessionId) }
    fun cancelTurn(workspaceId: String, sessionId: String) { session?.cancelTurn(workspaceId, sessionId) }
    fun answer(workspaceId: String, sessionId: String, request: QuestionRequest, forms: Map<String, QuestionForm>): Boolean =
        session?.answer(workspaceId, sessionId, request, forms) ?: false
    fun loadDir(workspaceId: String, path: String) { session?.loadDir(workspaceId, path) }
    fun loadFile(workspaceId: String, path: String) { session?.loadFile(workspaceId, path) }
    fun loadChanges(workspaceId: String) { session?.loadChanges(workspaceId) }
    fun loadDiff(workspaceId: String, path: String) { session?.loadDiff(workspaceId, path) }
}
