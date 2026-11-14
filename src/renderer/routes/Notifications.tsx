import { useEffect } from 'react'
import { KIND_VIEWS } from '../components/notifications/kinds'
import { relativeTime } from '../components/ui/relativeTime'
import { useToasts } from '../components/ui/Toast'
import { unreadCount, useNotifications } from '../state/notifications'
import '../components/notifications/notifications.css'
import './settings.css'

/** Everything from the last three days, newest first. Open ones can still be answered here. */
export function Notifications() {
  const items = useNotifications((state) => state.items)
  const unread = useNotifications(unreadCount)

  // Opening the page marks everything read, and so does anything that arrives while it is open.
  useEffect(() => {
    if (unread === 0) return
    void useNotifications
      .getState()
      .markAllRead()
      .catch((error: unknown) => useToasts.getState().push(String(error), 'err'))
  }, [unread])

  return (
    <main className="main elevated">
      <header className="settings-head">
        <h1 className="settings-page-title">Notifications</h1>
        <p className="settings-page-desc">Questions Loom asked you, and what became of them.</p>
      </header>
      <div className="settings-scroll">
        <section className="settings-section">
          {items.length === 0 && <p className="settings-note">Nothing in the last three days.</p>}
          {items.map((notification) => {
            const view = KIND_VIEWS[notification.kind]
            return (
              <div key={notification.id} className="settings-row">
                <span className="settings-provider">
                  <span className="notification-title">
                    {view.title(notification)}{' '}
                    <span className="settings-state">{relativeTime(notification.createdAt)}</span>
                  </span>
                  <span className="settings-state">{view.detail(notification)}</span>
                </span>
                {notification.closedAt === null && <view.Actions notification={notification} />}
              </div>
            )
          })}
        </section>
      </div>
    </main>
  )
}
