import { z } from 'zod'

/**
 * What every notification carries, whatever it is about. A kind extends this with its own
 * `kind` and `payload`. These are schemas, not classes: a notification travels from runner
 * to desktop as JSON.
 */
export const notificationBase = z.object({
  id: z.string(),
  /** The one user it is for; null on this Mac, where there is one user. */
  ownerId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  createdAt: z.number(),
  /** Null until its owner answers it or opens the Notifications page. */
  readAt: z.number().nullable(),
  /** Null while it still accepts an answer. */
  closedAt: z.number().nullable()
})

/** Asks whether a cloud workspace that only weak signals are holding up is still in use. */
export const idlePrompt = notificationBase.extend({
  kind: z.literal('idle-prompt'),
  payload: z.object({
    /** What was holding the workspace up: a live port forward, a terminal command, or both. */
    reason: z.enum(['forward', 'command', 'both']),
    answer: z.enum(['yes', 'no', 'none']).nullable(),
    /** When the workspace stops if nothing changes. */
    stopAt: z.number(),
    outcome: z.enum(['kept', 'stopped']).nullable()
  })
})

/** Every kind, joined by `kind`. */
export const notification = z.discriminatedUnion('kind', [idlePrompt])

export type Notification = z.infer<typeof notification>
export type NotificationKind = Notification['kind']
export type NotificationOf<K extends NotificationKind> = Extract<Notification, { kind: K }>
export type IdlePrompt = NotificationOf<'idle-prompt'>

/** The answer a desktop records when a card ran out unanswered. It is not the person's, so it marks nothing read. */
export const NO_RESPONSE = 'none'

/** One notification, pushed to its owner whenever it is raised or changes. */
export const NOTIFICATION_CHANNEL = 'notifications:changed'

export const NOTIFICATION_TTL_MS = 3 * 24 * 60 * 60 * 1000
