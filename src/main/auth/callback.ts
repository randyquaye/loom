const CALLBACK_PATH = '/callback'
/** RFC 8252 section 7.3: the loopback address itself, never a name that could resolve elsewhere. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]'])

/** Whether a URL's hostname is this machine and nothing else. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname)
}

/**
 * Where a one-time code may be sent. Loom has one known client, the desktop app, which
 * listens on a port it picks on its own machine; nothing else is ever a valid destination.
 */
export function isDesktopCallback(uri: string): boolean {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  return (
    url.protocol === 'http:' &&
    isLoopbackHost(url.hostname) &&
    url.port !== '' &&
    url.pathname === CALLBACK_PATH &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    !uri.includes('#')
  )
}
