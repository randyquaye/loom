package dev.loom.app.android.runner

import dev.loom.app.android.core.asList
import dev.loom.app.android.core.asObject
import dev.loom.app.android.core.bool
import dev.loom.app.android.core.long
import dev.loom.app.android.core.obj
import dev.loom.app.android.core.string

/** Rows as the runner sends them (src/shared/ipc-contract.ts), reduced to what the app shows. */
data class Project(val id: String, val name: String)

data class Workspace(
    val id: String,
    val projectId: String,
    val name: String,
    val branch: String,
    val archived: Boolean,
    val state: String,
    val runtime: String,
    val botId: String?,
    val botAccess: String?,
) {
    val isBot: Boolean get() = botId != null
    /** Display hint only; the runner enforces access on every call. */
    val canControl: Boolean get() = botId == null || botAccess == "control"
    val hasPower: Boolean get() = runtime == "container"
}

data class Power(val state: String, val error: String?)

data class SessionInfo(
    val id: String,
    val workspaceId: String,
    val backend: String,
    val model: String,
    val effort: String,
    val title: String,
    val createdAt: Long,
    val closedAt: Long?,
)

data class FileEntry(val name: String, val path: String, val isDir: Boolean)

data class Change(val path: String, val status: String, val staged: Boolean, val unstaged: Boolean)

data class Unread(val workspaceId: String, val eventId: Long, val seq: Long)

data class Queued(val id: String, val text: String)

data class FileText(val text: String, val language: String)

object Rows {
    private val ID = Regex("^[^\\u0000-\\u001f]{1,64}$")

    private fun id(value: String?): String? = value?.takeIf { ID.matches(it) }

    private fun rows(value: Any?): List<Map<String, Any?>> =
        (value.asList() ?: emptyList()).mapNotNull { it.asObject() }

    fun projects(value: Any?): List<Project> = rows(value).mapNotNull { row ->
        Project(id(row.string("id")) ?: return@mapNotNull null, row.string("name") ?: "Project")
    }

    fun workspace(row: Map<String, Any?>): Workspace? {
        val bot = row.obj("bot")
        return Workspace(
            id = id(row.string("id")) ?: return null,
            projectId = id(row.string("projectId")) ?: return null,
            name = row.string("name") ?: return null,
            branch = row.string("branch") ?: "",
            archived = row.bool("archived") ?: false,
            state = row.string("state") ?: "ready",
            runtime = row.string("runtime") ?: "container",
            botId = bot?.string("id"),
            botAccess = bot?.string("access")?.takeIf { it == "view" || it == "control" } ?: bot?.let { "view" },
        )
    }

    fun workspaces(value: Any?): List<Workspace> = rows(value).mapNotNull(::workspace)

    fun power(value: Any?): Power? {
        val row = value.asObject() ?: return null
        val state = row.string("state")?.takeIf { it in setOf("stopped", "starting", "running", "stopping", "error") }
            ?: return null
        return Power(state, row.string("error"))
    }

    fun sessions(value: Any?): List<SessionInfo> = rows(value).mapNotNull { row ->
        SessionInfo(
            id = id(row.string("id")) ?: return@mapNotNull null,
            workspaceId = id(row.string("workspaceId")) ?: return@mapNotNull null,
            backend = row.string("backend") ?: "",
            model = row.string("model") ?: "",
            effort = row.string("effort") ?: "",
            title = row.string("title")?.takeIf { it.isNotBlank() } ?: "Untitled session",
            createdAt = row.long("createdAt") ?: 0,
            closedAt = row.long("closedAt"),
        )
    }

    /** `files:listDir` paths are made server-relative again (root listing uses "."). */
    fun files(value: Any?): List<FileEntry> = rows(value).mapNotNull { row ->
        val name = row.string("name") ?: return@mapNotNull null
        val path = row.string("path")?.removePrefix("./") ?: return@mapNotNull null
        if (path.isEmpty() || path.startsWith("/") || path.split('/').any { it == ".." }) return@mapNotNull null
        FileEntry(name, path, row.string("kind") == "dir")
    }

    fun changes(value: Any?): List<Change> = rows(value).mapNotNull { row ->
        Change(
            path = row.string("path") ?: return@mapNotNull null,
            status = row.string("status") ?: "modified",
            staged = row.bool("staged") ?: false,
            unstaged = row.bool("unstaged") ?: false,
        )
    }

    fun unread(value: Any?): Map<String, Unread> {
        val map = value.asObject() ?: return emptyMap()
        return buildMap {
            for ((sessionId, item) in map) {
                val row = item.asObject() ?: continue
                put(sessionId, unreadRow(row) ?: continue)
            }
        }
    }

    fun unreadRow(row: Map<String, Any?>): Unread? {
        val workspaceId = row.string("workspaceId") ?: return null
        val seq = row.long("seq") ?: return null
        return Unread(workspaceId, row.long("eventId") ?: 0, seq)
    }

    /** `{revision, bySession: {sessionId: workspaceId}}`: sessions with a turn in progress. */
    fun activity(value: Any?): Pair<Long, Map<String, String>>? {
        val row = value.asObject() ?: return null
        val revision = row.long("revision") ?: return null
        val bySession = row.obj("bySession") ?: return null
        return revision to bySession.mapNotNull { (k, v) -> (v as? String)?.let { k to it } }.toMap()
    }

    fun queue(value: Any?): List<Queued> = rows(value).mapNotNull { row ->
        Queued(row.string("id") ?: return@mapNotNull null, row.string("text") ?: "")
    }

    fun fileText(value: Any?): FileText? {
        val row = value.asObject() ?: return null
        return FileText(row.string("text") ?: return null, row.string("language") ?: "")
    }
}
