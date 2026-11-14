import type { Notifications } from '../notifications/service'
import { handle } from './registry'

/**
 * The same three calls on this Mac and on a runner. A runner names the signed-in caller, who
 * sees only their own; the window names nobody, and this Mac's notifications have no owner.
 */
export function registerNotificationsIpc(notifications: Notifications): void {
  handle('notifications:list', (_input, caller) => notifications.list(caller?.userId ?? null))
  handle('notifications:read', (_input, caller) => notifications.markRead(caller?.userId ?? null))
  handle('notifications:answer', ({ id, answer }, caller) =>
    notifications.answer(caller?.userId ?? null, id, answer)
  )
}
