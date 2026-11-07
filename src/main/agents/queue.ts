import type { AgentEvent } from '../../shared/events'

export interface EventQueue {
  push(event: AgentEvent): void
  end(): void
  readonly iterable: AsyncIterable<AgentEvent>
}

/**
 * Single-consumer queue shared by the CLI and loop execution paths; `end()`
 * makes the async iterator finish. Kept in one place so the two backends
 * cannot drift in their event-delivery semantics.
 */
export function createEventQueue(): EventQueue {
  const buffered: AgentEvent[] = []
  let waiting: ((result: IteratorResult<AgentEvent>) => void) | null = null
  let ended = false

  return {
    push(event: AgentEvent): void {
      if (ended) return
      if (waiting) {
        const settle = waiting
        waiting = null
        settle({ value: event, done: false })
        return
      }
      buffered.push(event)
    },
    end(): void {
      if (ended) return
      ended = true
      if (waiting) {
        const settle = waiting
        waiting = null
        settle({ value: undefined, done: true })
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        return {
          next(): Promise<IteratorResult<AgentEvent>> {
            const value = buffered.shift()
            if (value !== undefined) return Promise.resolve({ value, done: false })
            if (ended) return Promise.resolve({ value: undefined, done: true })
            return new Promise<IteratorResult<AgentEvent>>((settle) => {
              waiting = settle
            })
          }
        }
      }
    }
  }
}
