package dev.loom.app.android.app

import android.content.Intent
import dev.loom.app.android.auth.AuthPort
import dev.loom.app.android.auth.AuthState
import dev.loom.app.android.core.Json
import dev.loom.app.android.core.asObject
import dev.loom.app.android.core.string
import dev.loom.app.android.runner.LinkState
import dev.loom.app.android.runner.RunnerCallException
import dev.loom.app.android.runner.RunnerPort
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Fully disconnected sample data for screenshots and layout review. It never touches the
 * network, credentials or the real store, and the UI labels it "Preview".
 *
 * This file is in the `debug` source set: release builds do not contain it, and their
 * [PreviewMode] always answers "no".
 */
object PreviewMode {
    /** `adb shell am start -S -n dev.loom.app.android/.MainActivity --ez preview true` */
    private const val EXTRA = "preview"
    private var store: AppStore? = null

    /** The sample store when this launch asked for it; null for every ordinary launch. */
    fun storeFor(intent: Intent?): AppStore? {
        if (intent?.getBooleanExtra(EXTRA, false) != true) return null
        return store ?: AppStore(PreviewAuth(), PreviewRunner(), preview = true).also { preview ->
            store = preview
            // A screenshot route exists only in this disconnected debug implementation.
            intent.getStringExtra("previewRoute")?.let { route ->
                CoroutineScope(Dispatchers.Main.immediate).launch {
                    preview.state.first { it.data.inventoryLoaded }
                    val parts = route.split(':', limit = 3)
                    val id = parts.getOrElse(1) { "" }
                    when (parts.first()) {
                        "session" -> {
                            val workspaceId = if (id == "s2") "w2" else "w1"
                            preview.loadSessions(workspaceId)
                            preview.state.first { it.data.sessions[workspaceId] is Loadable.Ready }
                            preview.selectConversation(workspaceId, id)
                        }
                        "files" -> preview.push(Screen.Files(id, "."))
                        "changes" -> preview.push(Screen.Changes(id))
                        "workspace" -> preview.push(Screen.Workspace(id))
                        "account" -> preview.push(Screen.Account)
                    }
                }
            }
        }
    }
}

class PreviewAuth : AuthPort {
    override val state: StateFlow<AuthState> =
        MutableStateFlow(AuthState.SignedIn("preview.invalid", "preview@example.com", session = 0))
    override suspend fun begin(originText: String, emailText: String) =
        Result.failure<String>(IllegalStateException("Preview is not connected"))
    override suspend fun cancelSignIn() = Unit
    override suspend fun complete(rawCallback: String?) = Unit
    override suspend fun signOut() = Unit
    override suspend fun endSession(ended: AuthState.SignedIn, notice: String) = Unit
}

class PreviewRunner : RunnerPort {
    override val link: StateFlow<LinkState> = MutableStateFlow(LinkState.Idle)
    private val linkState get() = link as MutableStateFlow<LinkState>

    override fun rebind(onPush: ((channel: String, payload: Any?) -> Unit)?) { linkState.value = LinkState.Idle }
    override fun start() { linkState.value = LinkState.Connected }
    override fun pause() { linkState.value = LinkState.Paused }
    override fun reconnect() = start()
    override fun close() = Unit

    override suspend fun callIdentified(channel: String, input: Any?): Any? = call(channel, input)

    override suspend fun call(channel: String, input: Any?): Any? {
        val args = input.asObject() ?: emptyMap()
        return when (channel) {
            "projects:list" -> Json.parse(PROJECTS)
            "workspaces:list" -> Json.parse(if (args.string("projectId") == "p1") WORKSPACES_P1 else WORKSPACES_P2)
            "workspaces:power" -> Json.parse(
                if (args.string("workspaceId") == "w3") """{"state":"stopped","error":null}""" else """{"state":"running","error":null}"""
            )
            "workspaces:start" -> Json.parse("""{"state":"starting","error":null}""")
            "workspaces:stop" -> Json.parse("""{"state":"stopping","error":null}""")
            "sessions:activity" -> Json.parse("""{"revision":1,"bySession":{"s1":"w1"}}""")
            "sessions:unread" -> Json.parse("""{"s2":{"workspaceId":"w2","eventId":4,"seq":2}}""")
            "sessions:list" -> Json.parse(
                when (args.string("workspaceId")) {
                    "w1" -> """[{"id":"s6","workspaceId":"w1","backend":"claude","model":"opus","effort":"high","title":"Safe checkout retries","createdAt":3,"closedAt":null}, {"id":"s1","workspaceId":"w1","backend":"claude","model":"opus","effort":"high","title":"Harden token refresh","createdAt":2,"closedAt":null}]"""
                    "w2" -> """[{"id":"s2","workspaceId":"w2","backend":"codex","model":"gpt","effort":"medium","title":"Nightly dependency audit","createdAt":1,"closedAt":null,"forkedFrom":null,"providerSessionId":null}]"""
                    else -> "[]"
                }
            )
            "sessions:eventsAfter" -> Json.parse(when (args.string("sessionId")) { "s6" -> EVENTS_CHAT; "s1" -> EVENTS_S1; else -> EVENTS_S2 })
            "sessions:queue" -> Json.parse("[]")
            "files:listDir" -> Json.parse(
                if (args.string("path") == ".") """[{"name":"src","path":"./src","kind":"dir"},{"name":"README.md","path":"./README.md","kind":"file"}]"""
                else """[{"name":"auth.ts","path":"src/auth.ts","kind":"file"}]"""
            )
            "files:read" -> Json.parse("""{"text":"export function refresh(token: string) {\n  return rotate(token)\n}\n","language":"typescript"}""")
            "git:status" -> Json.parse("""[{"path":"src/auth.ts","status":"modified","staged":false,"unstaged":true}]""")
            "git:diff" -> "@@ -1,3 +1,4 @@\n export function refresh(token: string) {\n-  return rotate(token)\n+  const next = rotate(token)\n+  return persist(next)\n }\n"
            "sessions:send", "sessions:cancel", "sessions:answerQuestion", "sessions:markRead" -> null
            else -> throw RunnerCallException("Preview has no data for $channel")
        }
    }

    private companion object {
        const val PROJECTS = """[{"id":"p1","name":"storefront"},{"id":"p2","name":"billing-service"}]"""
        const val WORKSPACES_P1 = """[
          {"id":"w1","projectId":"p1","name":"checkout-retries","branch":"loom/checkout-retries","archived":false,"state":"ready","runtime":"container","ownerId":"u"},
          {"id":"w3","projectId":"p1","name":"empty-workspace","branch":"loom/empty","archived":false,"state":"ready","runtime":"container","ownerId":"u"}]"""
        const val WORKSPACES_P2 = """[
          {"id":"w2","projectId":"p2","name":"audit-bot","branch":"bot/audit","archived":false,"state":"ready","runtime":"container","ownerId":"b","bot":{"id":"b1","access":"view"}}]"""
        const val EVENTS_S1 = """[
          {"seq":1,"event":{"type":"user.text","turnId":"t1","text":"Make refresh rotation safe across two tabs."}},
          {"seq":2,"event":{"type":"turn.started","turnId":"t1","at":1}},
          {"seq":3,"event":{"type":"text.done","turnId":"t1","text":"I'll read the token code first."}},
          {"seq":4,"event":{"type":"tool.call","turnId":"t1","callId":"c1","name":"read_file","args":{"path":"src/auth.ts"}}},
          {"seq":5,"event":{"type":"tool.result","turnId":"t1","callId":"c1","ok":true,"output":"export function refresh(token: string) {"}},
          {"seq":6,"event":{"type":"text.done","turnId":"t1","text":"## Refresh is ready\n\nThe credential is saved **before use**.\n\n| Check | Result |\n| --- | --- |\n| Rotation | Passed |\n| Cancellation | Passed |\n\n- One owner for the sign-in\n- Private data stays in memory\n\n```ts\nawait lock.withLock { refresh() }\n```"}},
          {"seq":7,"event":{"type":"question.requested","requestId":"r1","turnId":"t1","blocking":true,"questions":[
            {"id":"scope","header":"Scope","question":"Apply to which clients?","options":[{"label":"Desktop","description":""},{"label":"Mobile","description":""}],"multiSelect":true},
            {"id":"mode","header":"Rollout","question":"How should it ship?","options":[{"label":"Now","description":"Merge today"},{"label":"Later","description":"Behind a flag"}],"isOther":true},
            {"id":"token","header":"Token","question":"Paste the staging token","options":null,"isSecret":true}]}}]"""
        const val EVENTS_CHAT = """[
          {"seq":1,"event":{"type":"user.text","turnId":"chat-demo","text":"Make retries safe without charging twice."}},
          {"seq":2,"event":{"type":"text.done","turnId":"chat-demo","text":"The retry path can submit the same payment twice when a request times out.\n\nI'll keep one payment identity across retries and check the timeout path."}},
          {"seq":3,"event":{"type":"tool.call","turnId":"chat-demo","callId":"demo-read","name":"read_file","args":{"path":"capture.ts"}}},
          {"seq":4,"event":{"type":"tool.result","turnId":"chat-demo","callId":"demo-read","ok":true,"output":"Synthetic preview source. No file was read."}},
          {"seq":5,"event":{"type":"user.text","turnId":"chat-demo-2","text":"Keep the existing API."}},
          {"seq":6,"event":{"type":"text.done","turnId":"chat-demo-2","text":"I'll preserve the API and update the retry handling in src/payments/capture.ts.\n\nYou can also read the [capture implementation](src/payments/capture.ts#L6)."}}
        ]"""
        const val EVENTS_S2 = """[
          {"seq":1,"event":{"type":"user.text","turnId":"t1","text":"Audit dependencies."}},
          {"seq":2,"event":{"type":"text.done","turnId":"t1","text":"No vulnerable packages found."}},
          {"seq":3,"event":{"type":"turn.done","turnId":"t1","stopReason":"end"}}]"""
    }
}
