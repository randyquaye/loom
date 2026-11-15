package dev.loom.app.android.core

import java.net.URLDecoder

/** Local chat links can only read a relative path in the selected workspace. */
object ChatFileLinks {
    const val PREFIX = "loom-file:"
    private val prosePath = Regex("""(?<![\w./:%-])([\w.-]+(?:/[\w.-]+)*\.(?:tsx|jsx|swift|kts|kt|md|json|js|ts|sh|py|tf|css|html|yml|yaml|go|rs|toml|txt))(?::\d+)?(?![\w/-]|\.\w|:\d)""")
    private val lineSuffix = Regex("""(?:#L?\d+|:\d+)$""")
    data class Match(val path: String, val range: IntRange)

    fun path(target: String): String? {
        val raw = target.removePrefix(PREFIX).replace(lineSuffix, "")
        val path = runCatching { URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8") }.getOrNull()?.removePrefix("./") ?: return null
        if (path.isEmpty() || path.startsWith('/') || path.any { it in "\\:%?#" || it.isISOControl() } ||
            path.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
        return path
    }

    fun matches(text: String): List<Match> = prosePath.findAll(text).mapNotNull { match ->
        path(match.groupValues[1])?.let { Match(it, match.range) }
    }.toList()
}
