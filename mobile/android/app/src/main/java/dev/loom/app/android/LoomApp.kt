package dev.loom.app.android

import android.app.Application
import dev.loom.app.android.app.AppStore
import dev.loom.app.android.auth.AuthManager
import dev.loom.app.android.auth.FileCredentialVault
import dev.loom.app.android.auth.KeystoreCipher
import dev.loom.app.android.auth.OkHttpAuthNetwork
import dev.loom.app.android.net.PinnedTransport
import dev.loom.app.android.net.PublicHttp
import dev.loom.app.android.runner.OkHttpSocketOpener
import dev.loom.app.android.runner.RunnerConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** Composition root: plain constructors, no frameworks. One store, one connection. */
class LoomApp : Application() {
    // Proof verification and TLS setup stay off the main thread; the manager's own gate, not
    // a thread, is what keeps its state consistent.
    private val authScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val store: AppStore by lazy {
        val http = PublicHttp()
        val transport = PinnedTransport(http)
        val auth = AuthManager(FileCredentialVault(noBackupFilesDir, KeystoreCipher()), OkHttpAuthNetwork(http, transport), authScope)
        val connection = RunnerConnection(OkHttpSocketOpener(auth, transport))
        auth.restore()
        AppStore(auth, connection)
    }
}
