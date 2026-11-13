import type { AgentEvent } from './events'

/** Provider IDs differ from prompt IDs. Known older IDs cannot close a newer prompt. */
export function openTurn(events: Iterable<AgentEvent>): { promptId: string; turnId: string } | undefined {
  const owners = new Map<string, string>()
  let active: { promptId: string; turnId: string; announced: boolean } | undefined
  for (const event of events) {
    if (event.type === 'user.text') {
      owners.set(event.turnId, event.turnId)
      active = { promptId: event.turnId, turnId: event.turnId, announced: false }
    } else if (event.type === 'turn.started') {
      const owner = owners.get(event.turnId)
      if (active === undefined) {
        if (owner !== undefined) continue
        active = { promptId: event.turnId, turnId: event.turnId, announced: true }
      }
      if (owner !== undefined && owner !== active.promptId) continue
      owners.set(event.turnId, active.promptId)
      active.turnId = event.turnId
      active.announced = true
    } else if (event.type === 'turn.done') {
      const owner = owners.get(event.turnId)
      if (active === undefined) {
        if (owner === undefined) owners.set(event.turnId, event.turnId)
      } else if (owner === active.promptId || (owner === undefined && !active.announced)) {
        // Legacy failed starts can finish without announcing the provider's ID first.
        owners.set(event.turnId, active.promptId)
        active = undefined
      }
    }
  }
  return active
}
