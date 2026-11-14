import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Theme sheets must load before component sheets so component css wins ties.
import './theme/tokens.css'
import './theme/ui.css'
import { App } from './App'
import { installFocusTracking } from './components/ui/focus'
import { subscribeCloud } from './state/cloud'
import { subscribeNotifications } from './state/notifications'
import { subscribeSessionEvents, useSessions } from './state/sessions'
import { shouldPlayCompletionSound } from './audio/completionPolicy'

installFocusTracking()
// Live agent events (streaming text, turn.started/turn.done) feed the chat and the composer's running state.
subscribeSessionEvents(shouldPlayCompletionSound)
subscribeCloud()
subscribeNotifications()
void useSessions
  .getState()
  .loadUnread()
  .catch((error: unknown) => console.error('Could not load unread sessions', error))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
