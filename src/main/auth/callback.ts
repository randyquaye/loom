const CALLBACK_PATH = '/callback'
/** RFC 8252 section 7.3: the loopback address itself, never a name that could resolve elsewhere. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]'])

/** Fixed native clients, matched as raw strings rather than normalized URLs. */
const MOBILE_CALLBACKS: ReadonlySet<string> = new Set([
  'dev.loom.app.ios:/oauth/callback',
  'dev.loom.app.android:/oauth/callback'
])

export function isMobileCallback(uri: string): boolean {
  return MOBILE_CALLBACKS.has(uri)
}

export function isSignInCallback(uri: string): boolean {
  return isMobileCallback(uri) || isDesktopCallback(uri)
}

/** Whether a URL's hostname is this machine and nothing else. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname)
}

/**
 * Desktop codes return only to a literal loopback port owned by that desktop.
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
