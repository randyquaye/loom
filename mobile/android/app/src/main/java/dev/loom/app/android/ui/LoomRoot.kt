package dev.loom.app.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import dev.loom.app.android.app.AppStore
import dev.loom.app.android.auth.AuthState

/** Sign-in owns the chat shell and all of its transient navigation state. */
@Composable
fun LoomRoot(store: AppStore, openBrowser: (String) -> Boolean) {
    val state by store.state.collectAsState()
    when (val auth = state.auth) {
        AuthState.Restoring -> CenteredMessage(title = "Loom", body = "Opening…", loading = true)
        is AuthState.SignedOut, is AuthState.SigningIn -> SignInScreen(store, auth, openBrowser)
        is AuthState.StorageUnavailable -> StorageUnavailableScreen(auth.message, store::retryStorage)
        is AuthState.SignedIn -> key(auth.session) {
            ChatShell(store, state, auth)
        }
    }
    // At the root no handler is enabled, so system back leaves the app as usual.
}
