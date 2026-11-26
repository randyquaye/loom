package dev.loom.app.android.auth

import android.content.ActivityNotFoundException
import androidx.activity.ComponentActivity
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsClient
import androidx.core.net.toUri

/**
 * Sign-in through the default browser's Auth Tab. The redirect comes back to the activity
 * that opened the tab, as an activity result from the one browser the intent was addressed
 * to. The app declares no intent filter for its redirect scheme, so there is nothing another
 * app could register to be handed the code instead.
 *
 * A browser without Auth Tab is refused: AndroidX would otherwise fall back to a Custom Tab,
 * whose redirect can only return through exactly such an intent filter.
 */
class AuthBrowser(activity: ComponentActivity, onReturn: (redirect: String?) -> Unit) {
    private val context = activity.applicationContext

    // Registered while the activity is being created, as activity results require.
    private val launcher = AuthTabIntent.registerActivityResultLauncher(activity) { result ->
        onReturn(result.resultUri?.takeIf { result.resultCode == AuthTabIntent.RESULT_OK }?.toString())
    }

    /** False when the default browser has no Auth Tab: nothing is opened. */
    fun open(url: String): Boolean {
        val browser = CustomTabsClient.getPackageName(context, null) ?: return false
        if (!CustomTabsClient.isAuthTabSupported(context, browser)) return false
        val tab = AuthTabIntent.Builder().build()
        tab.intent.setPackage(browser)
        return try {
            tab.launch(launcher, url.toUri(), REDIRECT_SCHEME)
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }

    private companion object {
        val REDIRECT_SCHEME = OAuthCallback.REDIRECT_URI.substringBefore(':')
    }
}
