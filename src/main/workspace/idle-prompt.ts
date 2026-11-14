import { idlePrompt, type IdlePrompt } from '../../shared/notifications'
import type { Notifications } from '../notifications/service'
import type { IdlePrompts } from './power'

interface IdlePromptOptions {
  notifications: Notifications
  ownerOf(workspaceId: string): string | null
  /** Whether one of this user's desktops is connected, to show the card. */
  isConnected(userId: string): boolean
  /** Yes: the owner is still using the workspace. */
  keep(workspaceId: string): void
  /** No: the workspace stops now, and its forwards close with it. */
  stop(workspaceId: string): Promise<unknown>
  now?: () => number
}

export interface IdlePromptKind extends IdlePrompts {
  /** The workspace is no longer running, whoever stopped it. */
  stopped(workspaceId: string): void
  /** A starting runner has removed every container: no question is left to ask. */
  stoppedAll(): void
}

const answers = idlePrompt.shape.payload.shape.answer.unwrap()

/**
 * The first kind of notification: "are you still using this?", raised when only weak signals
 * have held a workspace up for too long. One is open for a workspace only while it runs.
 */
export function createIdlePrompts(options: IdlePromptOptions): IdlePromptKind {
  const { notifications } = options
  const now = options.now ?? Date.now
  const openFor = (workspaceId: string): IdlePrompt | undefined =>
    notifications.open('idle-prompt', workspaceId)[0]

  function close(prompt: IdlePrompt, outcome: 'kept' | 'stopped', answer = prompt.payload.answer): void {
    notifications.save({ ...prompt, closedAt: now(), payload: { ...prompt.payload, answer, outcome } })
  }

  notifications.handle('idle-prompt', async (prompt, given) => {
    const answer = answers.parse(given)
    if (answer === 'none') {
      // The card ran out. The question stays open, and answerable, until `stopAt`.
      if (prompt.payload.answer === null)
        notifications.save({ ...prompt, payload: { ...prompt.payload, answer } })
      return false
    }
    if (answer === 'yes') {
      if (prompt.workspaceId !== null) options.keep(prompt.workspaceId)
      close(prompt, 'kept', answer)
      return true
    }
    notifications.save({ ...prompt, payload: { ...prompt.payload, answer } })
    // The stop is what closes the question: see `stopped`.
    if (prompt.workspaceId !== null) await options.stop(prompt.workspaceId)
    return true
  })

  return {
    open(workspaceId) {
      const prompt = openFor(workspaceId)
      return prompt === undefined ? null : { raisedAt: prompt.createdAt, stopAt: prompt.payload.stopAt }
    },
    raise(workspaceId, reason, stopAt) {
      const ownerId = options.ownerOf(workspaceId)
      // With no desktop to show a card, nobody can let it run out: that is No Response already.
      const shown = ownerId !== null && options.isConnected(ownerId)
      notifications.raise({
        ownerId,
        kind: 'idle-prompt',
        workspaceId,
        payload: { reason, answer: shown ? null : 'none', stopAt, outcome: null }
      })
    },
    kept(workspaceId) {
      const prompt = openFor(workspaceId)
      if (prompt !== undefined) close(prompt, 'kept')
    },
    stopped(workspaceId) {
      const prompt = openFor(workspaceId)
      if (prompt !== undefined) close(prompt, 'stopped')
    },
    stoppedAll() {
      for (const prompt of notifications.open('idle-prompt')) close(prompt, 'stopped')
    }
  }
}
