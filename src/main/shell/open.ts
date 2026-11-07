import { shell } from 'electron'

const ALLOWED_EXTERNAL_SCHEMES = new Set(['https:', 'http:'])

/**
 * The single door out of the app: only http(s) reaches LaunchServices, malformed URLs are
 * dropped rather than handed over, and nothing opens without an explicit user click. Shared
 * by the window-navigation lock and the transcript's clickable web links.
 */
export async function openExternalSafe(url: string): Promise<void> {
  try {
    const parsed = new URL(url)
    if (ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) await shell.openExternal(url)
  } catch {
    // malformed URLs are dropped rather than handed to LaunchServices
  }
}
