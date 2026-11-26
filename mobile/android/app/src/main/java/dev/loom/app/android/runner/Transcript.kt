package dev.loom.app.android.runner

import dev.loom.app.android.core.asList
import dev.loom.app.android.core.asObject
import dev.loom.app.android.core.bool
import dev.loom.app.android.core.list
import dev.loom.app.android.core.long
import dev.loom.app.android.core.obj
import dev.loom.app.android.core.string
import java.util.TreeMap

data class QuestionOption(val label: String, val description: String)

data class QuestionSpec(
    val id: String,
    val header: String,
    val question: String,
    val options: List<QuestionOption>,
    val isOther: Boolean,
    val isSecret: Boolean,
    val multiSelect: Boolean,
)

data class QuestionRequest(
    val requestId: String,
    val turnId: String,
    val blocking: Boolean,
    val approval: Boolean,
    val questions: List<QuestionSpec>,
)

enum class QuestionStatus { Open, Answered, Resolved, Closed }

sealed interface TranscriptItem {
    val key: String

    data class User(override val key: String, val turnId: String, val text: String, val steer: Boolean) : TranscriptItem
    data class Assistant(override val key: String, val turnId: String, val text: String, val final: Boolean) : TranscriptItem
    data class Tool(
        override val key: String,
        val turnId: String,
        val callId: String,
        val name: String,
        val summary: String,
        val ok: Boolean?,
        val output: String?,
        val patchCount: Int,
    ) : TranscriptItem
    data class Subagent(
        override val key: String,
        val turnId: String,
        val callId: String,
        val description: String,
        val done: Boolean,
        val ok: Boolean?,
    ) : TranscriptItem
    data class Question(
        override val key: String,
        val request: QuestionRequest,
        val status: QuestionStatus,
        /** Answers to non-secret questions only; secret answers are never kept. */
        val visibleAnswers: Map<String, List<String>> = emptyMap(),
    ) : TranscriptItem
    data class Error(override val key: String, val message: String) : TranscriptItem
    data class TurnEnd(override val key: String, val turnId: String, val stopReason: String) : TranscriptItem
}

/**
 * Folds one session's numbered events (`{seq, event}`, from 1, no gaps) into a transcript.
 * Replay results and live pushes go through the same path: anything at or below the cursor
 * is a duplicate, anything beyond the next number waits until the gap is filled. Memory only.
 */
class Transcript(val sessionId: String) {
    var cursor: Long = 0
        private set
    var runningTurn: String? = null
        private set

    private val pending = TreeMap<Long, Map<String, Any?>>()
    private val list = ArrayList<TranscriptItem>()
    private val openText = HashMap<String, Int>()
    private var keys = 0L

    val items: List<TranscriptItem> get() = list.toList()

    /** True when events beyond the cursor are waiting for missing ones. */
    val hasGap: Boolean get() = pending.isNotEmpty()

    val openQuestions: List<TranscriptItem.Question>
        get() = list.filterIsInstance<TranscriptItem.Question>().filter { it.status == QuestionStatus.Open }

    /** Returns true when the visible transcript changed. */
    fun accept(seq: Long, event: Any?): Boolean {
        val body = event.asObject() ?: return false
        if (seq <= cursor || pending.containsKey(seq)) return false
        if (pending.size >= MAX_PENDING) return false // Fetched again by the next catch-up.
        pending[seq] = body
        var changed = false
        while (true) {
            val next = pending.remove(cursor + 1) ?: break
            cursor++
            changed = apply(next) || changed
        }
        return changed
    }

    /** `sessions:eventsAfter` result: `[{seq, event}]`. Malformed entries are skipped. */
    fun acceptReplay(value: Any?): Boolean {
        var changed = false
        for (entry in value.asList() ?: return false) {
            val row = entry.asObject() ?: continue
            val seq = row.long("seq") ?: continue
            changed = accept(seq, row["event"]) || changed
        }
        return changed
    }

    private fun key(prefix: String) = "$prefix${keys++}"

    private fun closeText(turnId: String) {
        openText.remove(turnId)
    }

    private fun apply(event: Map<String, Any?>): Boolean {
        val turnId = event.string("turnId") ?: ""
        when (event.string("type")) {
            "user.text", "user.steer" -> {
                closeText(turnId)
                list += TranscriptItem.User(key("u"), turnId, event.string("text") ?: "", event["type"] == "user.steer")
            }
            "turn.started" -> {
                runningTurn = turnId
                return false
            }
            "text.delta" -> {
                val text = event.string("text") ?: return false
                val index = openText[turnId]
                val current = index?.let { list[it] as? TranscriptItem.Assistant }
                if (current == null) {
                    openText[turnId] = list.size
                    list += TranscriptItem.Assistant(key("a"), turnId, text, final = false)
                } else {
                    list[index] = current.copy(text = current.text + text)
                }
            }
            "text.done" -> {
                // Complete text for the current segment: replace what was streamed, never append.
                val text = event.string("text") ?: return false
                val index = openText.remove(turnId)
                    ?: list.indexOfLast { it is TranscriptItem.Assistant && it.turnId == turnId && !it.final }
                        .takeIf { it >= 0 }
                val current = index?.let { list[it] as? TranscriptItem.Assistant }
                if (current != null) list[index] = current.copy(text = text, final = true)
                else list += TranscriptItem.Assistant(key("a"), turnId, text, final = true)
            }
            "tool.call" -> {
                closeText(turnId)
                val name = event.string("name") ?: "tool"
                list += TranscriptItem.Tool(
                    key("t"), turnId, event.string("callId") ?: "", name,
                    toolSummary(name, event["args"]), ok = null, output = null, patchCount = 0,
                )
            }
            "tool.result" -> {
                val callId = event.string("callId") ?: return false
                val index = list.indexOfLast { it is TranscriptItem.Tool && it.callId == callId }
                if (index < 0) return false
                val tool = list[index] as TranscriptItem.Tool
                list[index] = tool.copy(
                    ok = event.bool("ok") ?: false,
                    output = event.string("output")?.let(::bounded),
                    patchCount = event.list("patches")?.size ?: 0,
                )
            }
            "subagent.start" -> {
                closeText(turnId)
                list += TranscriptItem.Subagent(
                    key("s"), turnId, event.string("callId") ?: "",
                    event.string("description") ?: "Subagent", done = false, ok = null,
                )
            }
            "subagent.end" -> {
                val callId = event.string("callId") ?: return false
                val index = list.indexOfLast { it is TranscriptItem.Subagent && it.callId == callId }
                if (index < 0) return false
                list[index] = (list[index] as TranscriptItem.Subagent).copy(done = true, ok = event.bool("ok"))
            }
            "question.requested" -> {
                closeText(turnId)
                val request = parseQuestion(event) ?: return false
                val index = list.indexOfFirst { it is TranscriptItem.Question && it.request.requestId == request.requestId }
                val item = TranscriptItem.Question(key("q"), request, QuestionStatus.Open)
                if (index >= 0) list[index] = item.copy(key = list[index].key) else list += item
            }
            "question.answered" -> updateQuestion(event.string("requestId")) { q ->
                val secret = q.request.questions.filter { it.isSecret }.map { it.id }.toSet()
                val answers = event.obj("answers")?.mapNotNull { (id, values) ->
                    if (id in secret) null else id to (values.asList() ?: emptyList()).filterIsInstance<String>()
                }?.toMap() ?: emptyMap()
                q.copy(status = QuestionStatus.Answered, visibleAnswers = answers)
            }
            "question.resolved" -> updateQuestion(event.string("requestId")) { q ->
                if (q.status == QuestionStatus.Open) q.copy(status = QuestionStatus.Resolved) else q
            }
            "turn.done" -> {
                closeText(turnId)
                for (i in list.indices) {
                    val item = list[i]
                    if (item is TranscriptItem.Assistant && item.turnId == turnId && !item.final) {
                        list[i] = item.copy(final = true)
                    } else if (item is TranscriptItem.Question && item.request.turnId == turnId &&
                        item.status == QuestionStatus.Open
                    ) {
                        list[i] = item.copy(status = QuestionStatus.Closed)
                    }
                }
                if (runningTurn == turnId) runningTurn = null
                val reason = event.string("stopReason") ?: "end"
                if (reason != "end") list += TranscriptItem.TurnEnd(key("e"), turnId, reason)
            }
            "error" -> {
                if (turnId.isNotEmpty()) closeText(turnId)
                list += TranscriptItem.Error(key("x"), event.string("message") ?: "The agent reported an error")
            }
            else -> return false // reasoning, usage, subagent progress and future types.
        }
        return true
    }

    private inline fun updateQuestion(
        requestId: String?,
        change: (TranscriptItem.Question) -> TranscriptItem.Question,
    ): Boolean {
        val index = list.indexOfFirst { it is TranscriptItem.Question && it.request.requestId == requestId }
        if (requestId == null || index < 0) return false
        list[index] = change(list[index] as TranscriptItem.Question)
        return true
    }

    companion object {
        const val MAX_PENDING = 10_000
        const val MAX_OUTPUT_CHARS = 16_000

        private fun bounded(text: String) =
            if (text.length <= MAX_OUTPUT_CHARS) text else text.take(MAX_OUTPUT_CHARS) + "\n… (output truncated)"

        fun parseQuestion(event: Map<String, Any?>): QuestionRequest? {
            val requestId = event.string("requestId") ?: return null
            val questions = (event.list("questions") ?: return null).mapNotNull { item ->
                val q = item.asObject() ?: return@mapNotNull null
                QuestionSpec(
                    id = q.string("id") ?: return@mapNotNull null,
                    header = q.string("header") ?: "",
                    question = q.string("question") ?: "",
                    options = (q.list("options") ?: emptyList()).mapNotNull { o ->
                        val option = o.asObject() ?: return@mapNotNull null
                        QuestionOption(option.string("label") ?: return@mapNotNull null, option.string("description") ?: "")
                    },
                    isOther = q.bool("isOther") ?: false,
                    isSecret = q.bool("isSecret") ?: false,
                    multiSelect = q.bool("multiSelect") ?: false,
                )
            }
            return QuestionRequest(
                requestId = requestId,
                turnId = event.string("turnId") ?: "",
                blocking = event.bool("blocking") ?: true,
                approval = event["purpose"] == "approval",
                questions = questions,
            )
        }

        /** A one-line, human summary of a tool call; never a raw JSON dump. */
        fun toolSummary(name: String, args: Any?): String {
            val map = args.asObject() ?: return ""
            val preferred = when (name) {
                "bash" -> listOf("command")
                "read_file", "write_file", "edit_file" -> listOf("path", "file_path")
                "glob", "grep" -> listOf("pattern")
                else -> emptyList()
            } + listOf("command", "path", "file_path", "pattern", "url", "query", "description")
            val value = preferred.firstNotNullOfOrNull { map.string(it)?.takeIf(String::isNotBlank) } ?: return ""
            val line = value.lineSequence().first().trim()
            return if (line.length > 160) line.take(160) + "…" else line
        }
    }
}

/** What the person entered for one question. [OTHER] in [selected] means "use [text]". */
data class QuestionForm(val selected: List<String> = emptyList(), val text: String = "") {
    companion object {
        const val OTHER = "\u0000other"
    }
}

object QuestionAnswers {
    /** `{questionId: [values]}` as the desktop sends it, or null while anything is incomplete. */
    fun build(request: QuestionRequest, forms: Map<String, QuestionForm>): Map<String, List<String>>? {
        val answers = LinkedHashMap<String, List<String>>()
        for (question in request.questions) {
            val form = forms[question.id] ?: QuestionForm()
            val values = if (question.options.isEmpty()) {
                listOf(form.text)
            } else {
                val labels = question.options.map { it.label }.toSet()
                form.selected.map { choice ->
                    when {
                        choice == QuestionForm.OTHER && question.isOther -> form.text
                        choice in labels -> choice
                        else -> return null
                    }
                }
            }
            if (values.isEmpty() || values.any { it.isBlank() }) return null
            if (question.options.isNotEmpty() && !question.multiSelect && values.size != 1) return null
            answers[question.id] = values
        }
        return answers
    }
}
