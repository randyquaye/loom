import { create } from 'zustand'
import {
  NO_RESPONSE,
  type Notification,
  type NotificationKind,
  type NotificationOf
} from '../../shared/notifications'

/** How long a card waits for an answer before it goes and No Response is recorded. */
export const CARD_MS = 30_000

/** Per kind: whether an open notification is still waiting to be put in front of its owner. */
const AWAITS_ANSWER: { [K in NotificationKind]: (notification: NotificationOf<K>) => boolean } = {
  'idle-prompt': (prompt) => prompt.payload.answer === null
}

function wantsCard(notification: Notification): boolean {
  return notification.closedAt === null && AWAITS_ANSWER[notification.kind](notification)
}

interface NotificationsState {
  /** Newest first, from every source: this Mac and the runner it follows. */
  items: Notification[]
  /** The notifications showing as cards, oldest first. */
  cards: string[]
  load(): Promise<void>
  /** Takes one raised or changed notification, from a push or from an answer. */
  apply(notification: Notification): void
  answer(id: string, answer: string): Promise<void>
  /** What opening the Notifications page does. */
  markAllRead(): Promise<void>
}

export function unreadCount(state: Pick<NotificationsState, 'items'>): number {
  return state.items.filter((notification) => notification.readAt === null).length
}

/** One countdown per card, kept here so a card on screen and its timeout cannot disagree. */
const countdowns = new Map<string, ReturnType<typeof setTimeout>>()
/** Ids pushed while a list was being asked for: the push is newer than the answer. */
let pushedSinceLoad = new Set<string>()

export const useNotifications = create<NotificationsState>((set, get) => {
  function hide(id: string): void {
    clearTimeout(countdowns.get(id))
    countdowns.delete(id)
    set((state) => ({ cards: state.cards.filter((card) => card !== id) }))
  }

  function show(id: string): void {
    if (countdowns.has(id)) return
    const ranOut = (): void => {
      hide(id)
      void get()
        .answer(id, NO_RESPONSE)
        .catch((error: unknown) => console.error('Could not record No Response', error))
    }
    countdowns.set(id, setTimeout(ranOut, CARD_MS))
    set((state) => ({ cards: [...state.cards, id] }))
  }

  function place(items: Notification[]): void {
    set({ items: [...items].sort((a, b) => b.createdAt - a.createdAt) })
    const wanted = new Set(items.filter(wantsCard).map((notification) => notification.id))
    for (const id of get().cards) if (!wanted.has(id)) hide(id)
    for (const id of wanted) show(id)
  }

  return {
    items: [],
    cards: [],
    async load() {
      const pushed = new Set<string>()
      pushedSinceLoad = pushed
      const listed = await window.loom.notifications.list()
      place([
        ...get().items.filter((notification) => pushed.has(notification.id)),
        ...listed.filter((notification) => !pushed.has(notification.id))
      ])
    },
    apply(notification) {
      pushedSinceLoad.add(notification.id)
      place([...get().items.filter((known) => known.id !== notification.id), notification])
    },
    async answer(id, answer) {
      get().apply(await window.loom.notifications.answer(id, answer))
    },
    async markAllRead() {
      if (unreadCount(get()) === 0) return
      await window.loom.notifications.read()
      const readAt = Date.now()
      set((state) => ({
        items: state.items.map((notification) =>
          notification.readAt === null ? { ...notification, readAt } : notification
        )
      }))
    }
  }
})

let subscribed = false

export function subscribeNotifications(): void {
  if (subscribed) return
  subscribed = true
  window.loom.onNotification((notification) => useNotifications.getState().apply(notification))
  void useNotifications
    .getState()
    .load()
    .catch((error: unknown) => console.error('Could not load notifications', error))
}
