/** Optional additions to the stable runner protocol, requested on each connection. */
export const RUNNER_CAPABILITIES = ['bots.v1', 'subscriptions.v1'] as const
/** Mobile support is additive; existing desktops keep their established capability request. */
export const MOBILE_CAPABILITY = 'mobile.v1'
export const SERVER_CAPABILITIES = [...RUNNER_CAPABILITIES, MOBILE_CAPABILITY] as const
export const RUNNER_CAPABILITIES_HEADER = 'x-loom-capabilities'

export function supportsBots(capabilities?: readonly string[]): boolean {
  return capabilities?.includes('bots.v1') ?? false
}

export function supportsSubscriptions(capabilities?: readonly string[]): boolean {
  return capabilities?.includes('subscriptions.v1') ?? false
}
