package dev.loom.app.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Light = lightColorScheme(
    primary = Color(0xFF1C1C1E),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFF0F0F2),
    onPrimaryContainer = Color(0xFF1C1C1E),
    secondaryContainer = Color(0xFFF0F0F2),
    onSecondaryContainer = Color(0xFF1C1C1E),
    tertiaryContainer = Color(0xFFFFE8C2),
    onTertiaryContainer = Color(0xFF3A2600),
    background = Color.White,
    onBackground = Color(0xFF1C1C1E),
    surface = Color.White,
    onSurface = Color(0xFF1C1C1E),
    surfaceVariant = Color(0xFFF3F3F5),
    onSurfaceVariant = Color(0xFF636369),
    surfaceContainer = Color(0xFFF3F3F5),
    surfaceContainerHigh = Color(0xFFEBEBEE),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFFAFAFB),
    surfaceContainerHighest = Color(0xFFE5E5E9),
    surfaceBright = Color.White,
    surfaceDim = Color(0xFFF3F3F5),
    surfaceTint = Color(0xFF1C1C1E),
    outline = Color(0xFF77777F),
    outlineVariant = Color(0xFFDEDEE2),
    error = Color(0xFFB3261E),
    errorContainer = Color(0xFFF9DEDC),
    onErrorContainer = Color(0xFF410E0B),
)

private val Dark = darkColorScheme(
    primary = Color(0xFFF5F5F6),
    onPrimary = Color(0xFF171719),
    primaryContainer = Color(0xFF28282C),
    onPrimaryContainer = Color(0xFFF5F5F6),
    secondaryContainer = Color(0xFF28282C),
    onSecondaryContainer = Color(0xFFF5F5F6),
    tertiaryContainer = Color(0xFF4A3500),
    onTertiaryContainer = Color(0xFFFFE8C2),
    background = Color(0xFF111113),
    onBackground = Color(0xFFF5F5F6),
    surface = Color(0xFF111113),
    onSurface = Color(0xFFF5F5F6),
    surfaceVariant = Color(0xFF252529),
    onSurfaceVariant = Color(0xFFADADB5),
    surfaceContainer = Color(0xFF252529),
    surfaceContainerHigh = Color(0xFF2D2D32),
    surfaceContainerLowest = Color(0xFF0C0C0E),
    surfaceContainerLow = Color(0xFF1B1B1E),
    surfaceContainerHighest = Color(0xFF343438),
    surfaceBright = Color(0xFF343438),
    surfaceDim = Color(0xFF111113),
    surfaceTint = Color(0xFFF5F5F6),
    outline = Color(0xFF888891),
    outlineVariant = Color(0xFF34343A),
    error = Color(0xFFF2B8B5),
    errorContainer = Color(0xFF8C1D18),
    onErrorContainer = Color(0xFFF9DEDC),
)

/** Diff backgrounds; meaning is also carried by the +/- prefix and spoken labels. */
@Immutable
data class DiffColors(val added: Color, val removed: Color, val hunk: Color)

val LocalDiffColors = staticCompositionLocalOf { DiffColors(Color.Unspecified, Color.Unspecified, Color.Unspecified) }
val LocalLinkColor = staticCompositionLocalOf { Color(0xFF155CC5) }

@Composable
fun LoomTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val diff = if (dark) {
        DiffColors(Color(0xFF12361F), Color(0xFF4A1A1A), Color(0xFF252529))
    } else {
        DiffColors(Color(0xFFDDF4E3), Color(0xFFFBE0DE), Color(0xFFF0F0F2))
    }
    androidx.compose.runtime.CompositionLocalProvider(
        LocalDiffColors provides diff,
        LocalLinkColor provides if (dark) Color(0xFF8CB4FF) else Color(0xFF155CC5),
    ) {
        MaterialTheme(
            colorScheme = if (dark) Dark else Light,
            typography = Typography(
                bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
                bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
                bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
                titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
                titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 23.sp, fontWeight = FontWeight.SemiBold),
                titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.Medium),
            ),
            shapes = Shapes(
                small = RoundedCornerShape(12.dp),
                medium = RoundedCornerShape(18.dp),
                large = RoundedCornerShape(24.dp),
            ),
            content = content,
        )
    }
}
