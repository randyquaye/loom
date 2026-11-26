package dev.loom.app.android.ui

import android.content.ActivityNotFoundException
import android.net.Uri
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.withLink
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.NoOpImageTransformerImpl
import com.mikepenz.markdown.model.rememberMarkdownState
import com.mikepenz.markdown.model.markdownAnnotator
import dev.loom.app.android.core.ChatFileLinks
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes

/** Native GFM: local links use the scoped reader; web links use the browser; images never load. */
@Composable
fun AssistantMarkdown(text: String, openFile: ((String) -> Unit)? = null) {
    val browser = LocalUriHandler.current
    val webLinks = remember(browser, openFile) {
        object : UriHandler {
            override fun openUri(uri: String) {
                ChatFileLinks.path(uri)?.let { path -> openFile?.invoke(path); return }
                val parsed = Uri.parse(uri)
                if (parsed.scheme?.lowercase() !in setOf("https", "http") || parsed.host.isNullOrBlank()) return
                try {
                    browser.openUri(uri)
                } catch (_: ActivityNotFoundException) {
                    // A device without a web browser leaves the selectable link in the transcript.
                }
            }
        }
    }
    val linkStyle = TextLinkStyles(style = SpanStyle(color = LocalLinkColor.current))
    val fileLinks = remember(linkStyle, openFile, webLinks) {
        markdownAnnotator { content, child ->
            val excluded = setOf(MarkdownElementTypes.CODE_SPAN, MarkdownElementTypes.CODE_FENCE,
                MarkdownElementTypes.CODE_BLOCK, MarkdownElementTypes.INLINE_LINK, MarkdownElementTypes.IMAGE,
                MarkdownElementTypes.FULL_REFERENCE_LINK, MarkdownElementTypes.SHORT_REFERENCE_LINK,
                MarkdownElementTypes.LINK_DEFINITION, MarkdownElementTypes.AUTOLINK)
            if (openFile == null || child.type != MarkdownTokenTypes.TEXT ||
                generateSequence(child.parent) { it.parent }.any { it.type in excluded }) false
            else {
                val source = content.substring(child.startOffset, child.endOffset)
                val matches = ChatFileLinks.matches(source)
                if (matches.isEmpty()) false else {
                    var end = 0
                    for (match in matches) {
                        append(source.substring(end, match.range.first))
                        withLink(LinkAnnotation.Url(ChatFileLinks.PREFIX + match.path, linkStyle,
                            linkInteractionListener = { webLinks.openUri(ChatFileLinks.PREFIX + match.path) })) {
                            append(source.substring(match.range))
                        }
                        end = match.range.last + 1
                    }
                    append(source.substring(end))
                    true
                }
            }
        }
    }
    val markdown = rememberMarkdownState(text, retainState = true)
    CompositionLocalProvider(LocalUriHandler provides webLinks) {
        SelectionContainer {
            Markdown(
                markdownState = markdown,
                annotator = fileLinks,
                typography = markdownTypography(
                    textLink = linkStyle,
                    h1 = MaterialTheme.typography.titleLarge,
                    h2 = MaterialTheme.typography.titleLarge,
                    h3 = MaterialTheme.typography.titleMedium,
                    h4 = MaterialTheme.typography.titleMedium,
                    h5 = MaterialTheme.typography.titleSmall,
                    h6 = MaterialTheme.typography.titleSmall,
                ),
                imageTransformer = remember { NoOpImageTransformerImpl() },
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
