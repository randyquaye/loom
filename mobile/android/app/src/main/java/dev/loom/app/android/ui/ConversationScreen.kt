package dev.loom.app.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.foundation.background
import androidx.compose.ui.draw.rotate
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.IconButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import dev.loom.app.android.app.AppState
import dev.loom.app.android.app.AppStore
import dev.loom.app.android.app.Screen
import dev.loom.app.android.app.TranscriptView
import dev.loom.app.android.runner.TranscriptItem
import dev.loom.app.android.runner.QuestionForm
import dev.loom.app.android.runner.QuestionStatus
import dev.loom.app.android.runner.Workspace

@Composable
fun ConversationScreen(store: AppStore, state: AppState, workspaceId: String, sessionId: String, openDrawer: () -> Unit) {
    val workspace = state.data.workspace(workspaceId)
    val session = state.data.session(workspaceId, sessionId)
    val view = state.data.transcripts[sessionId] ?: TranscriptView()
    val running = sessionId in state.data.activity || view.runningTurn != null
    var options by remember { mutableStateOf(false) }
    LoomScaffold(
        store = store,
        state = state,
        title = session?.title ?: "Session",
        subtitle = workspace?.name,
        navigationIcon = { IconButton(onClick = openDrawer) { Icon(Icons.Default.Menu, "Workspaces") } },
        actions = {
            androidx.compose.foundation.layout.Box {
                IconButton(onClick = { options = true }) { Icon(Icons.Default.MoreVert, "Workspace options") }
                DropdownMenu(expanded = options, onDismissRequest = { options = false }) {
                    DropdownMenuItem(text = { Text("Workspace details") }, onClick = { options = false; store.push(Screen.Workspace(workspaceId)) })
                }
            }
        },
        bottomBar = {
            if (workspace != null) Composer(store, state, workspace, sessionId, running)
        },
    ) { padding ->
        Transcript(store, state, view, workspace, sessionId, running, Modifier.padding(padding))
    }
}

@Composable
private fun Transcript(
    store: AppStore,
    state: AppState,
    view: TranscriptView,
    workspace: Workspace?,
    sessionId: String,
    running: Boolean,
    modifier: Modifier,
) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    // Ordinary answers belong to this conversation, not to a recycled lazy-list card.
    val questionDrafts = remember(sessionId) { mutableStateMapOf<String, Map<String, QuestionForm>>() }
    LaunchedEffect(view.items, state.data.submitted) {
        val open = view.items.filterIsInstance<TranscriptItem.Question>()
            .filter { it.status == QuestionStatus.Open && it.request.requestId !in state.data.submitted }
            .map { it.request.requestId }.toSet()
        questionDrafts.keys.retainAll(open)
    }
    var followed by remember { mutableStateOf(true) }
    // Only the reader's own scrolling changes whether we follow; growing content never does.
    LaunchedEffect(listState) {
        var wasScrolling = false
        snapshotFlow { listState.isScrollInProgress to listState.canScrollForward }.collect { (scrolling, canForward) ->
            if (scrolling || wasScrolling) followed = !canForward
            wasScrolling = scrolling
        }
    }
    // Follow new output only while the reader is already at the bottom.
    LaunchedEffect(view.items.size, view.items.lastOrNull()) {
        if (followed && view.items.isNotEmpty()) listState.scrollToItem(view.items.size - 1, Int.MAX_VALUE / 2)
    }
    Box(modifier.fillMaxSize()) {
        when {
            view.loading && view.items.isEmpty() -> CenteredMessage("Loading session…", loading = true)
            view.error != null && view.items.isEmpty() -> CenteredMessage("Couldn't load this session", view.error)
            view.items.isEmpty() -> CenteredMessage("No messages yet", "Send a message to start this session's first turn.")
            else -> LazyColumn(
                state = listState,
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 24.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(view.items, key = { it.key }) { item ->
                    when (item) {
                        is TranscriptItem.User -> UserBubble(item)
                        is TranscriptItem.Assistant -> AssistantMarkdown(item.text, openFile = { path ->
                            if (workspace != null) store.push(Screen.FileView(workspace.id, path))
                        })
                        is TranscriptItem.Tool -> ToolRow(item)
                        is TranscriptItem.Subagent -> Text(
                            "Subagent: ${item.description} — " +
                                when { !item.done -> "running"; item.ok == false -> "failed"; else -> "finished" },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        is TranscriptItem.Question -> QuestionCard(
                            item = item,
                            canAnswer = workspace?.canControl == true && state.connected,
                            viewOnly = workspace?.canControl == false,
                            busy = item.request.requestId in state.data.answering,
                            submitted = item.request.requestId in state.data.submitted,
                            draft = questionDrafts[item.request.requestId].orEmpty(),
                            onDraftChange = { questionDrafts[item.request.requestId] = it },
                            onSubmit = { forms -> workspace != null && store.answer(workspace.id, sessionId, item.request, forms) },
                        )
                        is TranscriptItem.Error -> Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.small) {
                            Text(
                                "Error: ${item.message}",
                                color = MaterialTheme.colorScheme.onErrorContainer,
                                modifier = Modifier.padding(12.dp),
                            )
                        }
                        is TranscriptItem.TurnEnd -> Text(
                            when (item.stopReason) {
                                "cancelled" -> "Turn stopped"
                                "interrupted" -> "Turn interrupted; nothing was re-sent"
                                "limit" -> "Turn ended: limit reached"
                                "error" -> "Turn ended with an error"
                                else -> "Turn ended"
                            },
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        )
                    }
                }
                if (view.error != null) {
                    item { Text("Couldn't refresh: ${view.error}", color = MaterialTheme.colorScheme.error) }
                }
                if (running) item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                        Text("Working…", style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(start = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        if (!followed && view.items.isNotEmpty()) {
            SmallFloatingActionButton(
                onClick = {
                    followed = true
                    scope.launch { listState.animateScrollToItem(view.items.size - 1, Int.MAX_VALUE / 2) }
                },
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
            ) { Icon(Icons.Default.KeyboardArrowDown, contentDescription = "Jump to latest") }
        }
    }
}

@Composable
private fun UserBubble(item: TranscriptItem.User) {
    Box(Modifier.fillMaxWidth().padding(start = 40.dp), contentAlignment = Alignment.CenterEnd) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainer,
            shape = RoundedCornerShape(20.dp),
            modifier = Modifier.widthIn(max = 560.dp).semantics(mergeDescendants = true) {},
        ) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                if (item.steer) Text("Steering message", style = MaterialTheme.typography.bodySmall)
                SelectionContainer {
                    Text(item.text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
                }
            }
        }
    }
}

@Composable
private fun ToolRow(item: TranscriptItem.Tool) {
    var expanded by remember { mutableStateOf(false) }
    val status = when (item.ok) {
        null -> "running"
        true -> "done"
        false -> "failed"
    }
    Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable(role = Role.Button, onClickLabel = if (expanded) "Hide output" else "Show output") { expanded = !expanded }
                    .semantics {
                        stateDescription = if (expanded) "Expanded" else "Collapsed"
                        contentDescription = "Tool ${item.name}, $status. ${item.summary}"
                    }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(listOf(item.name, item.summary, if (item.ok == true) "" else status).filter { it.isNotBlank() }.joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium, maxLines = 1,
                        color = if (item.ok == false) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                    if (item.patchCount > 0) {
                        Text("${item.patchCount} file change${if (item.patchCount == 1) "" else "s"}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (expanded) {
                SelectionContainer {
                    Text(
                        item.output?.ifEmpty { "(no output)" } ?: "Still running…",
                        fontFamily = Mono,
                        style = MaterialTheme.typography.bodySmall,
                        softWrap = false,
                        modifier = Modifier.horizontalScroll(rememberScrollState()).padding(12.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun Composer(store: AppStore, state: AppState, workspace: Workspace, sessionId: String, running: Boolean) {
    var confirmStop by remember { mutableStateOf(false) }
    Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.navigationBarsPadding().imePadding()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            state.data.session(workspace.id, sessionId)?.let { session ->
                Text(listOf(session.backend, session.model, session.effort).filter { it.isNotBlank() }.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 10.dp).semantics {
                        contentDescription = "Current model: ${session.backend}, ${session.model}, ${session.effort}"
                    })
            }
            val queue = state.data.queues[sessionId].orEmpty()
            if (queue.isNotEmpty()) Text(
                if (queue.size == 1) "1 message queued" else "${queue.size} messages queued",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!workspace.canControl) {
                Text("View only. This workspace is shared without control access.", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
                return@Column
            }
            val draft = state.data.drafts[sessionId].orEmpty()
            val outgoing = state.data.outgoing[sessionId]
            val sending = outgoing?.inFlight == true
            Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(26.dp)) {
                Row(verticalAlignment = Alignment.Bottom, modifier = Modifier.fillMaxWidth().padding(6.dp)) {
                    if (running) IconButton(onClick = { confirmStop = true },
                        enabled = state.connected && sessionId !in state.data.cancelling,
                        modifier = Modifier.semantics { contentDescription = "Stop turn" }) {
                        Box(Modifier.size(14.dp).background(MaterialTheme.colorScheme.onSurface, RoundedCornerShape(2.dp)))
                    }
                    BasicTextField(
                        value = draft,
                        onValueChange = { store.setDraft(sessionId, it) },
                        enabled = !sending,
                        maxLines = 6,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        modifier = Modifier.weight(1f).padding(start = 12.dp, end = 8.dp, top = 12.dp, bottom = 12.dp)
                            .semantics { contentDescription = "Message" },
                        decorationBox = { field ->
                            Box {
                                if (draft.isEmpty()) Text(if (running) "Queue a message…" else "Message…",
                                    style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                field()
                            }
                        },
                    )
                    FilledIconButton(onClick = { store.send(workspace.id, sessionId) },
                        enabled = state.connected && !sending && draft.isNotBlank(), modifier = Modifier.size(44.dp)) {
                        if (sending) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        else Icon(Icons.AutoMirrored.Filled.ArrowBack, "Send message", Modifier.size(21.dp).rotate(90f))
                    }
                }
            }
            val status = when {
                sending -> "Sending…"
                outgoing?.error != null -> "Not sent: ${outgoing.error}. Your message is kept."
                !state.connected -> "Offline. You can keep typing until the connection returns."
                else -> null
            }
            if (status != null) Row(verticalAlignment = Alignment.CenterVertically) {
                Text(status, style = MaterialTheme.typography.bodySmall,
                    color = if (outgoing?.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite })
                if (outgoing?.error != null && state.connected) TextButton(onClick = { store.send(workspace.id, sessionId) }) { Text("Retry") }
            }
        }
    }
    if (confirmStop) AlertDialog(
        onDismissRequest = { confirmStop = false }, title = { Text("Stop this turn?") },
        text = { Text("The agent stops where it is. What it already did is kept.") },
        confirmButton = { TextButton(onClick = { confirmStop = false; store.cancelTurn(workspace.id, sessionId) }) { Text("Stop turn") } },
        dismissButton = { TextButton(onClick = { confirmStop = false }) { Text("Keep working") } },
    )
}
