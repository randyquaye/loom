/** Optional additions to the stable runner protocol, requested on each connection. */
export const RUNNER_CAPABILITIES: readonly string[] = []
export const RUNNER_CAPABILITIES_HEADER = 'x-loom-capabilities'

export function supportsBots(capabilities?: readonly string[]): boolean {
  return capabilities?.includes('bots.v1') ?? false
}
