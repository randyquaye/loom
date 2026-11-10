import type { AgentEvent } from './events'

export type UsageEvent = Extract<AgentEvent, { type: 'usage' }>
export const usageFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens'
] as const
export type UsageCounts = Pick<UsageEvent, (typeof usageFields)[number]>

export function addUsageCounts(base: UsageCounts, next: UsageCounts): UsageCounts {
  const sum = (field: 'cacheReadInputTokens' | 'cacheWriteInputTokens') =>
    base[field] === undefined && next[field] === undefined
      ? undefined
      : (base[field] ?? 0) + (next[field] ?? 0)
  return {
    inputTokens: base.inputTokens + next.inputTokens,
    outputTokens:
      base.outputTokens === undefined && next.outputTokens === undefined
        ? undefined
        : (base.outputTokens ?? 0) + (next.outputTokens ?? 0),
    cacheReadInputTokens: sum('cacheReadInputTokens'),
    cacheWriteInputTokens: sum('cacheWriteInputTokens')
  }
}

/** Snapshots replace earlier snapshots; an explicit request measurement is counted once. */
export function usageByTurn(events: AgentEvent[]): Map<string, UsageEvent> {
  const result = new Map<string, UsageEvent>()
  for (const event of events) {
    if (event.type !== 'usage') continue
    const previous = result.get(event.turnId)
    if (event.scope === 'thread' && previous?.scope === 'turn') continue
    const next = { ...event }
    for (const field of usageFields) {
      const value = event[field]
      if (event.scope === 'request') {
        if (value !== undefined) next[field] = (previous?.[field] ?? 0) + value
        else if (previous?.[field] !== undefined) next[field] = previous[field]
      } else if (value === undefined && previous?.[field] !== undefined) next[field] = previous[field]
    }
    if (event.scope === 'request') next.scope = 'turn'
    result.set(event.turnId, next)
  }
  return result
}
