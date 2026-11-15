package dev.loom.app.android

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import dev.loom.app.android.app.PreviewMode
import dev.loom.app.android.auth.AuthBrowser
import dev.loom.app.android.ui.LoomRoot
import dev.loom.app.android.ui.LoomTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Debug builds can open disconnected sample data; release builds have no such store.
        val preview = PreviewMode.storeFor(intent)
        val store = preview ?: (application as LoomApp).store
        if (preview == null) {
            // Everything real, sign-in included, stays out of screenshots, recordings and the
            // app switcher. Only the sample data above may be captured.
            window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
            if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        }
        enableEdgeToEdge()

        val browser = AuthBrowser(this, store::finishSignIn)
        lifecycle.addObserver(LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> store.foreground()
                Lifecycle.Event.ON_STOP -> store.background()
                else -> Unit
            }
        })

        setContent {
            LoomTheme {
                LoomRoot(store = store, openBrowser = browser::open)
            }
        }
    }
}
