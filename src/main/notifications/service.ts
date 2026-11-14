import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  notification as schema,
  NOTIFICATION_TTL_MS,
  type Notification,
  type NotificationKind,
  type NotificationOf
} from '../../shared/notifications'

interface Row {
  id: string
  owner_id: string | null
  kind: string
  workspace_id: string | null
  created_at: number
  read_at: number | null
  closed_at: number | null
  payload: string
}

/**
 * What an answer to one kind of notification does. It answers true when the answer was the
 * person's own, which marks the notification read.
 */
export type AnswerHandler<K extends NotificationKind> = (
  notification: NotificationOf<K>,
  answer: string
) => Promise<boolean> | boolean

export interface NotificationsOptions {
  db: Database.Database
  /** Delivers a raised or changed notification to its owner, and to nobody else. */
  changed(notification: Notification): void
  now?: () => number
}

/**
 * The rail every notification rides: one table, one owner each, one push when anything about
 * it changes. It knows nothing of any kind; a kind raises through it, saves its own changes
 * through it, and registers what an answer does.
 */
export function createNotifications(options: NotificationsOptions) {
  const { db } = options
  const now = options.now ?? Date.now
  /** Typed per kind where they are registered; `never` lets one map hold them all. */
  const handlers = new Map<string, (notification: never, answer: string) => Promise<boolean> | boolean>()

  function fromRow(row: Row): Notification {
    return schema.parse({
      id: row.id,
      ownerId: row.owner_id,
      kind: row.kind,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      readAt: row.read_at,
      closedAt: row.closed_at,
      payload: JSON.parse(row.payload)
    })
  }

  function select(where: string, ...values: unknown[]): Notification[] {
    const rows = db
      .prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, rowid DESC`)
      .all(...values) as Row[]
    return rows.map(fromRow)
  }

  function forget(): void {
    db.prepare('DELETE FROM notifications WHERE created_at <= ?').run(now() - NOTIFICATION_TTL_MS)
  }

  /** Stores what a kind changed about its notification and tells the owner. */
  function save<N extends Notification>(next: N): N {
    db.prepare('UPDATE notifications SET read_at = ?, closed_at = ?, payload = ? WHERE id = ?').run(
      next.readAt,
      next.closedAt,
      JSON.stringify(next.payload),
      next.id
    )
    options.changed(next)
    return next
  }

  return {
    save,

    /** Each kind says once what an answer to it does. */
    handle<K extends NotificationKind>(kind: K, handler: AnswerHandler<K>): void {
      handlers.set(kind, handler)
    },

    raise<K extends NotificationKind>(input: {
      ownerId: string | null
      kind: K
      workspaceId: string | null
      payload: NotificationOf<K>['payload']
    }): NotificationOf<K> {
      forget()
      const raised = schema.parse({
        ...input,
        id: randomUUID(),
        createdAt: now(),
        readAt: null,
        closedAt: null
      }) as NotificationOf<K>
      db.prepare(
        `INSERT INTO notifications (id, owner_id, kind, workspace_id, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        raised.id,
        raised.ownerId,
        raised.kind,
        raised.workspaceId,
        raised.createdAt,
        JSON.stringify(raised.payload)
      )
      options.changed(raised)
      return raised
    },

    /** The notifications of one kind still accepting an answer; about one workspace, when named. */
    open<K extends NotificationKind>(kind: K, workspaceId?: string): Array<NotificationOf<K>> {
      const found =
        workspaceId === undefined
          ? select('kind = ? AND closed_at IS NULL', kind)
          : select('kind = ? AND closed_at IS NULL AND workspace_id = ?', kind, workspaceId)
      return found as Array<NotificationOf<K>>
    },

    /** One owner's notifications, newest first. `IS` also matches this Mac's ownerless ones. */
    list(ownerId: string | null): Notification[] {
      forget()
      return select('owner_id IS ?', ownerId)
    },

    markRead(ownerId: string | null): void {
      for (const unread of select('owner_id IS ? AND read_at IS NULL', ownerId)) {
        save({ ...unread, readAt: now() })
      }
    },

    /** Runs the kind's handler. The first answer wins: a closed notification is returned as it is. */
    async answer(ownerId: string | null, id: string, answer: string): Promise<Notification> {
      const [current] = select('id = ? AND owner_id IS ?', id, ownerId)
      if (current === undefined) throw new Error(`notification ${id} was not found`)
      if (current.closedAt !== null) return current
      const handler = handlers.get(current.kind)
      if (handler === undefined) throw new Error(`nothing answers a ${current.kind} notification`)
      const byPerson = await handler(current as never, answer)
      const [after = current] = select('id = ?', id)
      return byPerson && after.readAt === null ? save({ ...after, readAt: now() }) : after
    }
  }
}

export type Notifications = ReturnType<typeof createNotifications>
