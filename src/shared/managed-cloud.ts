export type CloudSignInMode = 'company' | 'managed'

/** Only Loom-operated hostnames; a matching name still requires its published key. */
export function isManagedRunnerHost(host: string): boolean {
  if (host === 'pilot.loombox.xyz') return true
  const suffix = '.loombox.xyz'
  if (!host.endsWith(suffix)) return false
  const label = host.slice(0, -suffix.length)
  return label.length <= 63 && /^o-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)
}

export function isManagedRunnerOrigin(base: string): boolean {
  try {
    const url = new URL(base)
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      isManagedRunnerHost(url.hostname)
    )
  } catch {
    return false
  }
}

export function isGoogleClientId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    /^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(value)
  )
}

/** Gmail or a primary Workspace email whose current ownership Google can vouch for. */
export function isManagedGoogleEmail(email: string, hostedDomain: string | null): boolean {
  const parts = email.toLowerCase().split('@')
  if (parts.length !== 2 || !parts[0]) return false
  return parts[1] === 'gmail.com' || (hostedDomain !== null && parts[1] === hostedDomain.toLowerCase())
}

export function cloudAuthPath(mode: CloudSignInMode | undefined, route: string): string {
  return `/auth${mode === 'managed' ? '/managed' : ''}/${route}`
}
