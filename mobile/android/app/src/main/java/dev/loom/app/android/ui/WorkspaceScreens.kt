package dev.loom.app.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.loom.app.android.app.AppState
import dev.loom.app.android.app.AppStore
import dev.loom.app.android.auth.AuthState

@Composable
fun WorkspaceScreen(store: AppStore, state: AppState, workspaceId: String, sessionId: String? = null) {
    val workspace = state.data.workspace(workspaceId)
    var confirmStop by remember { mutableStateOf(false) }
    LoomScaffold(store, state, title = "Workspace details", onBack = { store.pop() }) { padding ->
        if (workspace == null) {
            CenteredMessage("Workspace unavailable", "It was removed or is no longer shared with you.", Modifier.padding(padding))
        } else {
            val power = state.data.power[workspaceId]
            val session = sessionId?.let { state.data.session(workspaceId, it) }
            Column(
                verticalArrangement = Arrangement.spacedBy(20.dp),
                modifier = Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
            ) {
                DetailRow("Workspace", workspace.name)
                DetailRow("Branch", workspace.branch)
                Text(if (workspace.state == "ready" && power != null) powerText(power.state) else workspaceStateText(workspace.state),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (session != null) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    DetailRow("Session", session.title)
                    DetailRow("Provider and model", "${session.backend} · ${session.model}")
                    if (session.effort.isNotBlank()) DetailRow("Reasoning effort", session.effort)
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                if (workspace.isBot) Text(
                    if (workspace.canControl) "Shared with control access." else "View only. You can read sessions and linked files.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (workspace.state == "error") Text("Open this workspace in Loom on your desktop to inspect its setup log.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (workspace.hasPower && workspace.canControl) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    val busy = workspaceId in state.data.powerBusy || power?.state in setOf("starting", "stopping")
                    val running = power?.state == "running"
                    TextButton(
                        onClick = { if (running) confirmStop = true else store.setPower(workspaceId, start = true) },
                        enabled = state.connected && power != null && !busy,
                        colors = ButtonDefaults.textButtonColors(contentColor = if (running) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary),
                    ) { Text(if (busy) "Updating workspace…" else if (running) "Stop workspace" else "Start workspace") }
                    power?.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }
    if (confirmStop) AlertDialog(
        onDismissRequest = { confirmStop = false },
        title = { Text("Stop this workspace?") },
        text = { Text("Running agents are interrupted. Files and sessions are kept.") },
        confirmButton = { TextButton(onClick = { confirmStop = false; store.setPower(workspaceId, start = false) }) { Text("Stop workspace") } },
        dismissButton = { TextButton(onClick = { confirmStop = false }) { Text("Keep running") } },
    )
}

@Composable
fun AccountScreen(store: AppStore, state: AppState, auth: AuthState.SignedIn) {
    var confirm by remember { mutableStateOf(false) }
    LoomScaffold(store, state, title = "Account", onBack = { store.pop() }) { padding ->
        Column(verticalArrangement = Arrangement.spacedBy(20.dp),
            modifier = Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
            DetailRow("Email", auth.email)
            DetailRow("Organization", auth.host)
            DetailRow("Connection", if (state.connected && !state.preview) "Connected" else if (state.preview) "Sample data · Not connected" else "Not connected")
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Text("On your phone", style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
            Text("Continue sessions, answer questions, and view files linked in chat. Agents keep working when you close the app.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("Create workspaces and sessions, configure providers, and manage your organization in Loom on your desktop.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            TextButton(onClick = { confirm = true }, enabled = !state.preview,
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Sign out") }
            Text("Removes this device’s access and clears loaded content. Agents keep running.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (confirm) AlertDialog(
        onDismissRequest = { confirm = false }, title = { Text("Sign out?") },
        text = { Text("Unsent messages are discarded and this device’s saved sign-in is removed.") },
        confirmButton = { TextButton(onClick = { confirm = false; store.signOut() }) { Text("Sign out") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
    )
}

@Composable
private fun DetailRow(title: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp), modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(title, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        SelectionContainer { Text(value, style = MaterialTheme.typography.bodyLarge) }
    }
}
