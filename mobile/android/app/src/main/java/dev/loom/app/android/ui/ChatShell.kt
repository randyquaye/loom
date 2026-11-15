package dev.loom.app.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.loom.app.android.app.*
import dev.loom.app.android.auth.AuthState
import kotlinx.coroutines.launch

/** The current chat stays mounted while its history drawer opens over it. */
@Composable
fun ChatShell(store: AppStore, state: AppState, auth: AuthState.SignedIn) {
    val screen = state.data.stack.last()
    val selected = state.data.stack.filterIsInstance<Screen.Conversation>().lastOrNull()
    val drawer = rememberDrawerState(if (screen == Screen.Workspaces) DrawerValue.Open else DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var expanded by remember { mutableStateOf(emptySet<String>()) }
    var openedInitialGroup by remember { mutableStateOf(false) }
    val primary = screen == Screen.Workspaces || screen is Screen.Conversation

    LaunchedEffect(state.data.inventoryLoaded) {
        if (state.data.inventoryLoaded && !openedInitialGroup) {
            openedInitialGroup = true
            state.data.projects.firstOrNull()?.let { project ->
                state.data.workspaces[project.id]?.firstOrNull { !it.archived }?.let { expanded = setOf(it.id) }
            }
        }
    }
    LaunchedEffect(expanded, state.connected) {
        if (state.connected) expanded.forEach(store::loadSessions)
    }
    LaunchedEffect(screen) {
        if (screen == Screen.Workspaces) drawer.open() else drawer.close()
    }
    LaunchedEffect(drawer.isOpen) {
        // Opening history must not summon the keyboard before the user chooses search.
        if (drawer.isOpen) focus.clearFocus(force = true)
    }
    BackHandler(enabled = state.data.stack.size > 1) { store.pop() }
    BackHandler(enabled = drawer.isOpen) { scope.launch { drawer.close() } }
    val openDrawer: () -> Unit = {
        focus.clearFocus()
        scope.launch { drawer.open() }
    }
    val closeDrawer: () -> Unit = { scope.launch { drawer.close() } }

    ModalNavigationDrawer(
        drawerState = drawer,
        gesturesEnabled = primary,
        drawerContent = {
            ModalDrawerSheet(
                modifier = Modifier.fillMaxWidth(0.88f).widthIn(max = 360.dp).imePadding(),
                drawerShape = RectangleShape,
                drawerContainerColor = MaterialTheme.colorScheme.surface,
            ) {
                ChatHistory(
                    store, state, auth, selected?.sessionId, expanded,
                    onExpand = { id -> expanded = if (id in expanded) expanded - id else expanded + id },
                    onSelect = { workspaceId, sessionId ->
                        focus.clearFocus()
                        store.selectConversation(workspaceId, sessionId)
                        closeDrawer()
                    },
                    onAccount = { store.push(Screen.Account); closeDrawer() },
                    onClose = closeDrawer,
                )
            }
        },
    ) {
        key(screen) {
            when (screen) {
                Screen.Workspaces -> LoomScaffold(
                    store, state, "Loom",
                    navigationIcon = { IconButton(onClick = openDrawer) { Icon(Icons.Default.Menu, "Workspaces") } },
                ) { padding ->
                    CenteredMessage(
                        "Your workspaces",
                        "Choose a workspace and session to continue where you left off.",
                        Modifier.padding(padding),
                        action = { TextButton(onClick = openDrawer) { Text("Browse workspaces") } },
                    )
                }
                is Screen.Conversation -> ConversationScreen(store, state, screen.workspaceId, screen.sessionId, openDrawer)
                Screen.Account -> AccountScreen(store, state, auth)
                is Screen.Workspace -> WorkspaceScreen(store, state, screen.workspaceId, selected?.sessionId)
                is Screen.Files -> FilesScreen(store, state, screen.workspaceId, screen.path)
                is Screen.FileView -> FileViewScreen(store, state, screen.workspaceId, screen.path)
                is Screen.Changes -> ChangesScreen(store, state, screen.workspaceId)
                is Screen.Diff -> DiffScreen(store, state, screen.workspaceId, screen.path)
            }
        }
    }
}

@Composable
private fun ChatHistory(
    store: AppStore,
    state: AppState,
    auth: AuthState.SignedIn,
    selected: String?,
    expanded: Set<String>,
    onExpand: (String) -> Unit,
    onSelect: (String, String) -> Unit,
    onAccount: () -> Unit,
    onClose: () -> Unit,
) {
    var options by remember { mutableStateOf(false) }
    val query = state.data.search.trim()
    val groups = state.data.projects.mapNotNull { project ->
        val workspaces = state.data.workspaces[project.id].orEmpty().filter { workspace ->
            (state.data.showArchived || !workspace.archived) &&
                (query.isEmpty() || project.name.contains(query, true) || workspace.name.contains(query, true) ||
                    (state.data.sessions[workspace.id] as? Loadable.Ready)?.value?.any { it.title.contains(query, true) } == true)
        }
        if (workspaces.isEmpty()) null else project to workspaces
    }
    Column(Modifier.fillMaxHeight().padding(horizontal = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp)) {
            TextField(
                value = state.data.search,
                onValueChange = store::setSearch,
                placeholder = { Text("Search", style = MaterialTheme.typography.bodyMedium) },
                leadingIcon = { Icon(Icons.Default.Search, null, Modifier.size(20.dp)) },
                singleLine = true,
                shape = RoundedCornerShape(16.dp),
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close workspaces", Modifier.size(20.dp)) }
        }
        if (query.isNotEmpty()) Text(
            "Searching projects, workspaces and loaded sessions",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 8.dp, bottom = 8.dp),
        )
        LazyColumn(modifier = Modifier.weight(1f), contentPadding = PaddingValues(bottom = 24.dp)) {
            if (state.preview) item { PreviewBanner() }
            if (state.data.inventoryError != null) item {
                Text("Couldn't refresh. ${state.data.inventoryError}", style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(8.dp), color = MaterialTheme.colorScheme.error)
                TextButton(onClick = store::reloadInventory) { Text("Try again") }
            }
            if (!state.data.inventoryLoaded && state.data.inventoryError == null) item {
                CenteredMessage("Loading workspaces…", loading = true, modifier = Modifier.heightIn(min = 160.dp))
            }
            if (state.data.inventoryLoaded && groups.isEmpty()) item {
                CenteredMessage(
                    if (query.isEmpty()) "No cloud workspaces yet" else "No matches",
                    if (query.isEmpty()) "Workspaces created on your desktop appear here." else "Try another project, workspace or session name.",
                    modifier = Modifier.heightIn(min = 180.dp),
                )
            }
            for ((project, workspaces) in groups) {
                item(key = "project:${project.id}") {
                    Text(project.name, style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 8.dp, top = 24.dp, bottom = 8.dp).semantics { heading() })
                }
                for (workspace in workspaces) {
                    val isExpanded = workspace.id in expanded || query.isNotEmpty()
                    item(key = "workspace:${workspace.id}") {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                .clickable(role = Role.Button, onClickLabel = if (isExpanded) "Collapse sessions" else "Expand sessions") { onExpand(workspace.id) }
                                .padding(horizontal = 8.dp, vertical = 10.dp),
                        ) {
                            Text(workspace.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                            Icon(if (isExpanded) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (isExpanded) {
                        when (val sessions = state.data.sessions[workspace.id]) {
                            is Loadable.Ready -> {
                                val rows = sessions.value.filter { query.isEmpty() || it.title.contains(query, true) ||
                                    project.name.contains(query, true) || workspace.name.contains(query, true) }
                                if (rows.isEmpty()) item(key = "empty:${workspace.id}") {
                                    Text(if (query.isEmpty()) "Start a session in Loom on your desktop." else "No matching sessions in this workspace.",
                                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(start = 20.dp, end = 8.dp, bottom = 12.dp))
                                }
                                items(rows, key = { "chat:${it.id}" }) { session ->
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier.fillMaxWidth()
                                            .background(if (selected == session.id) MaterialTheme.colorScheme.surfaceContainer else Color.Transparent, RoundedCornerShape(14.dp))
                                            .clickable(role = Role.Button, onClickLabel = "Open session") { onSelect(workspace.id, session.id) }
                                            .padding(start = 20.dp, end = 12.dp, top = 14.dp, bottom = 14.dp),
                                    ) {
                                        Text(session.title, style = MaterialTheme.typography.bodyLarge, maxLines = 2,
                                            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                        if (session.id in state.data.activity) {
                                            CircularProgressIndicator(Modifier.padding(start = 8.dp).size(14.dp)
                                                .semantics { contentDescription = "Agent working" }, strokeWidth = 2.dp)
                                        } else if ((state.data.unread[session.id]?.seq ?: 0) > 0) {
                                            Box(Modifier.padding(start = 8.dp).size(6.dp)
                                                .background(MaterialTheme.colorScheme.onSurface, CircleShape)
                                                .semantics { contentDescription = "New reply" })
                                        }
                                    }
                                }
                            }
                            is Loadable.Failed -> item(key = "failed:${workspace.id}") {
                                Text(sessions.message, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 20.dp))
                                TextButton(onClick = { store.loadSessions(workspace.id) }) { Text("Try again") }
                            }
                            else -> item(key = "loading:${workspace.id}") {
                                Row(Modifier.padding(start = 20.dp, top = 8.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                                    if (state.connected) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                                    Text(if (state.connected) "Loading sessions…" else "Reconnect to load sessions", style = MaterialTheme.typography.bodySmall,
                                        modifier = Modifier.padding(start = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.weight(1f).heightIn(min = 52.dp).clickable(role = Role.Button, onClick = onAccount).padding(8.dp)) {
                Icon(Icons.Default.AccountCircle, null, Modifier.size(28.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(auth.email.substringBefore('@'), style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(start = 12.dp).weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(Icons.Default.Settings, "Account and settings", Modifier.size(20.dp))
            }
            Box {
                IconButton(onClick = { options = true }) { Icon(Icons.Default.MoreVert, "Workspace list options") }
                DropdownMenu(expanded = options, onDismissRequest = { options = false }) {
                    DropdownMenuItem(text = { Text("Refresh workspaces") }, onClick = {
                        store.reloadInventory()
                        expanded.forEach(store::loadSessions)
                        options = false
                    })
                    DropdownMenuItem(text = { Text(if (state.data.showArchived) "Hide archived" else "Show archived") },
                        onClick = { store.setShowArchived(!state.data.showArchived); options = false })
                }
            }
        }
    }
}
