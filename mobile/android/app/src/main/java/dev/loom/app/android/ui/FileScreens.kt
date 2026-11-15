package dev.loom.app.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.loom.app.android.app.AppState
import dev.loom.app.android.app.AppStore
import dev.loom.app.android.app.Loadable
import dev.loom.app.android.app.Screen

private const val MAX_RENDERED_LINES = 20_000

private fun key(workspaceId: String, path: String) = "$workspaceId\u0000$path"

@Composable
private fun <T> Loaded(loadable: Loadable<T>?, retry: () -> Unit, modifier: Modifier, content: @Composable (T) -> Unit) {
    when (loadable) {
        null, Loadable.Loading -> CenteredMessage("Loading…", loading = true, modifier = modifier)
        is Loadable.Failed -> CenteredMessage(
            "Couldn't load this",
            loadable.message,
            modifier = modifier,
            action = { TextButton(onClick = retry) { Text("Try again") } },
        )
        is Loadable.Ready -> content(loadable.value)
    }
}

@Composable
fun FilesScreen(store: AppStore, state: AppState, workspaceId: String, path: String) {
    val workspace = state.data.workspace(workspaceId)
    LoomScaffold(
        store, state,
        title = if (path.isEmpty()) "Files" else path.substringAfterLast('/'),
        subtitle = listOfNotNull(workspace?.name, path.ifEmpty { null }).joinToString(" · "),
        onBack = { store.pop() },
    ) { padding ->
        Loaded(state.data.dirs[key(workspaceId, path)], { store.loadDir(workspaceId, path) }, Modifier.padding(padding)) { entries ->
            if (entries.isEmpty()) {
                CenteredMessage("This folder is empty", modifier = Modifier.padding(padding))
            } else {
                LazyColumn(Modifier.padding(padding).fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    items(entries, key = { it.path }) { entry ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .clickable(role = Role.Button, onClickLabel = if (entry.isDir) "Open folder" else "Open file") {
                                    store.push(if (entry.isDir) Screen.Files(workspaceId, entry.path) else Screen.FileView(workspaceId, entry.path))
                                }
                                .semantics { contentDescription = (if (entry.isDir) "Folder " else "File ") + entry.name }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                        ) {
                            Text(
                                if (entry.isDir) "${entry.name}/" else entry.name,
                                fontFamily = Mono,
                                style = MaterialTheme.typography.bodyLarge,
                                color = if (entry.isDir) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            if (entry.isDir) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        }
    }
}

/** Read-only, monospaced, selectable; wrapping can be switched off for horizontal scrolling. */
@Composable
private fun CodeLines(
    lines: List<String>,
    modifier: Modifier,
    background: @Composable (String) -> Color = { Color.Transparent },
    describe: (String) -> String? = { null },
) {
    var wrap by remember { mutableStateOf(false) }
    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = { wrap = !wrap }) { Text(if (wrap) "Don't wrap lines" else "Wrap lines") }
        }
        val scroll = rememberScrollState()
        SelectionContainer {
            LazyColumn(
                contentPadding = PaddingValues(bottom = 24.dp),
                modifier = if (wrap) Modifier.fillMaxSize() else Modifier.fillMaxSize().horizontalScroll(scroll),
            ) {
                itemsIndexed(lines.take(MAX_RENDERED_LINES)) { _, line ->
                    val spoken = describe(line)
                    Text(
                        line.ifEmpty { " " },
                        fontFamily = Mono,
                        style = MaterialTheme.typography.bodySmall,
                        softWrap = wrap,
                        modifier = Modifier
                            .background(background(line))
                            .padding(horizontal = 12.dp, vertical = 1.dp)
                            .then(if (spoken != null) Modifier.semantics { contentDescription = spoken } else Modifier),
                    )
                }
                if (lines.size > MAX_RENDERED_LINES) {
                    item { Text("… ${lines.size - MAX_RENDERED_LINES} more lines not shown on mobile", modifier = Modifier.padding(12.dp)) }
                }
            }
        }
    }
}

@Composable
fun FileViewScreen(store: AppStore, state: AppState, workspaceId: String, path: String) {
    LoomScaffold(store, state, title = path.substringAfterLast('/'), subtitle = path, onBack = { store.pop() }) { padding ->
        Loaded(state.data.fileTexts[key(workspaceId, path)], { store.loadFile(workspaceId, path) }, Modifier.padding(padding)) { file ->
            val lines = remember(file.text) { file.text.lines() }
            CodeLines(lines, Modifier.padding(padding))
        }
    }
}

private fun statusText(status: String) = when (status) {
    "modified" -> "Modified"
    "added" -> "Added"
    "deleted" -> "Deleted"
    "renamed" -> "Renamed"
    "untracked" -> "New, untracked"
    else -> status
}

@Composable
fun ChangesScreen(store: AppStore, state: AppState, workspaceId: String) {
    LoomScaffold(store, state, title = "Changes", subtitle = state.data.workspace(workspaceId)?.name, onBack = { store.pop() }) { padding ->
        Loaded(state.data.changes[workspaceId], { store.loadChanges(workspaceId) }, Modifier.padding(padding)) { changes ->
            if (changes.isEmpty()) {
                CenteredMessage("No uncommitted changes", modifier = Modifier.padding(padding))
            } else {
                LazyColumn(Modifier.padding(padding).fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    items(changes, key = { it.path }) { change ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 56.dp)
                                .clickable(role = Role.Button, onClickLabel = "Show diff") {
                                    store.push(Screen.Diff(workspaceId, change.path))
                                }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                        ) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(change.path, fontFamily = Mono, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(
                                    statusText(change.status) + when {
                                        change.staged && change.unstaged -> " · partly staged"
                                        change.staged -> " · staged"
                                        else -> ""
                                    },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        }
    }
}

@Composable
fun DiffScreen(store: AppStore, state: AppState, workspaceId: String, path: String) {
    val colors = LocalDiffColors.current
    LoomScaffold(store, state, title = path.substringAfterLast('/'), subtitle = "Diff · $path", onBack = { store.pop() }) { padding ->
        Loaded(state.data.diffs[key(workspaceId, path)], { store.loadDiff(workspaceId, path) }, Modifier.padding(padding)) { diff ->
            if (diff.isBlank()) {
                CenteredMessage("No differences to show", modifier = Modifier.padding(padding))
            } else {
                val lines = remember(diff) { diff.trimEnd('\n').lines() }
                CodeLines(
                    lines,
                    Modifier.padding(padding),
                    background = { line ->
                        when {
                            line.startsWith("+++") || line.startsWith("---") -> Color.Transparent
                            line.startsWith("+") -> colors.added
                            line.startsWith("-") -> colors.removed
                            line.startsWith("@@") -> colors.hunk
                            else -> Color.Transparent
                        }
                    },
                    describe = { line ->
                        when {
                            line.startsWith("+++") || line.startsWith("---") -> null
                            line.startsWith("+") -> "Added: ${line.drop(1)}"
                            line.startsWith("-") -> "Removed: ${line.drop(1)}"
                            line.startsWith("@@") -> "Section $line"
                            else -> null
                        }
                    },
                )
            }
        }
    }
}
