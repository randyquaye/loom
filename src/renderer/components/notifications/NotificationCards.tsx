import { CARD_MS, useNotifications } from '../../state/notifications'
import { KIND_VIEWS } from './kinds'
import './notifications.css'

/** Open notifications that still want an answer, bottom right, each for as long as its bar runs. */
export function NotificationCards() {
  const cards = useNotifications((state) => state.cards)
  const items = useNotifications((state) => state.items)
  return (
    <div className="notification-cards" aria-live="polite">
      {cards.map((id) => {
        const notification = items.find((item) => item.id === id)
        if (notification === undefined) return null
        const view = KIND_VIEWS[notification.kind]
        return (
          <section key={id} className="notification-card glass" aria-label="Notification">
            <div className="notification-title">{view.title(notification)}</div>
            <p className="notification-detail">{view.detail(notification)}</p>
            <div className="notification-actions">
              <view.Actions notification={notification} />
            </div>
            <div
              className="notification-countdown"
              style={{ animationDuration: `${CARD_MS}ms` }}
              aria-hidden="true"
            />
          </section>
        )
      })}
    </div>
  )
}
