import type { SessionEventPush } from '../../shared/ipc-contract'
import chimeUrl from './turn-complete.wav?url'

let player: HTMLAudioElement | null = null

function playChime(): void {
  player ??= new Audio(chimeUrl)
  player.currentTime = 0
  void player.play().catch((error: unknown) => console.warn('Could not play completion chime', error))
}

/** Observe live events only; loading transcript history must never replay notifications. */
export function createCompletionChime(
  play = playChime,
  shouldPlay: (sessionId: string) => boolean = () => true
): (push: SessionEventPush) => void {
  const turns = new Map<string, { turnId: string; complete: boolean }>()
  return ({ sessionId, event }) => {
    const previous = turns.get(sessionId)
    if (event.type === 'user.text' || event.type === 'turn.started') {
      if (previous?.turnId !== event.turnId) turns.set(sessionId, { turnId: event.turnId, complete: false })
    } else if (event.type === 'turn.done') {
      if (previous?.complete || (previous !== undefined && previous.turnId !== event.turnId)) return
      turns.set(sessionId, { turnId: event.turnId, complete: true })
      if (event.stopReason === 'end' && shouldPlay(sessionId)) play()
    }
  }
}
