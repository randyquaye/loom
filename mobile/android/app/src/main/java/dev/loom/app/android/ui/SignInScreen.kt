package dev.loom.app.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.loom.app.android.app.AppStore
import dev.loom.app.android.auth.AuthState
import kotlinx.coroutines.launch

/** Existing members only: host + primary work email, then the browser's Auth Tab. No invites. */
@Composable
fun SignInScreen(store: AppStore, auth: AuthState, openBrowser: (String) -> Boolean) {
    // Plain remember, never saved-state: nothing typed here is written to disk.
    var origin by remember { mutableStateOf("https://") }
    var email by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val signingIn = auth as? AuthState.SigningIn
    val notice = (auth as? AuthState.SignedOut)?.notice

    val scope = rememberCoroutineScope()

    fun submit() {
        scope.launch {
            store.beginSignIn(origin, email).fold(
                onSuccess = { url ->
                    error = null
                    if (!openBrowser(url)) {
                        store.cancelSignIn()
                        error = "Update your browser to sign in. Loom signs in through a secure browser tab " +
                            "that this device's default browser doesn't offer yet."
                    }
                },
                onFailure = { error = it.message },
            )
        }
    }

    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .safeDrawingPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 48.dp),
        ) {
            Column(
                verticalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier.widthIn(max = 480.dp).fillMaxWidth(),
            ) {
                Text("Loom", style = MaterialTheme.typography.titleSmall)
                Text("Connect to your workspaces", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() })
                Text(
                    "Use your work email and your organization’s Loom address.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (signingIn != null) {
                    SectionCard {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            CircularProgressIndicator(modifier = Modifier.size(24.dp))
                            Text(
                                signingIn.step,
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                            )
                        }
                        Text(
                            if (signingIn.awaitingBrowser) {
                                "Finish signing in to ${signingIn.host} using your primary work account."
                            } else {
                                "Connecting securely to ${signingIn.host}."
                            },
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        if (signingIn.awaitingBrowser) {
                            OutlinedButton(onClick = store::cancelSignIn) { Text("Cancel sign-in") }
                        }
                    }
                } else {
                    OutlinedTextField(
                        value = origin,
                        onValueChange = { origin = it.take(270) },
                        label = { Text("Organization address") },
                        supportingText = { Text("For example https://loom.example.com") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Next,
                            autoCorrectEnabled = false,
                            capitalization = KeyboardCapitalization.None,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = email,
                        onValueChange = { email = it.take(254) },
                        label = { Text("Primary work email") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Email,
                            imeAction = ImeAction.Go,
                            autoCorrectEnabled = false,
                        ),
                        keyboardActions = KeyboardActions(onGo = { submit() }),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(onClick = ::submit, enabled = email.isNotBlank() && origin.length > 8,
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text("Sign in with Google") }
                    Text("Sign-in opens in your browser. You must already belong to the organization.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                val message = error ?: notice
                if (message != null) {
                    Text(
                        message,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
                    )
                }
            }
        }
    }
}

/** No private screen or replacement sign-in is offered until secure storage answers. */
@Composable
fun StorageUnavailableScreen(message: String, retry: () -> Unit) {
    androidx.compose.material3.Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.safeDrawingPadding().padding(24.dp),
        ) {
            Text("Secure storage unavailable", style = MaterialTheme.typography.headlineSmall)
            Text(message, modifier = Modifier.padding(vertical = 16.dp))
            Button(onClick = retry) { Text("Try again") }
        }
    }
}
