import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Theme sheets must load before component sheets so component css wins ties.
import './theme/tokens.css'
import './theme/ui.css'
import { App } from './App'
import { installFocusTracking } from './components/ui/focus'
import { subscribeSessionEvents } from './state/sessions'

installFocusTracking()
// Live agent events (streaming text, turn.started/turn.done) feed the chat and the composer's running state.
subscribeSessionEvents()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
