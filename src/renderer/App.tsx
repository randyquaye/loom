import { useEffect } from 'react'
import { CommandPalette } from './components/ui/CommandPalette'
import { ModalHost } from './components/ui/ModalHost'
import { NotificationCards } from './components/notifications/NotificationCards'
import { UpdateNotice } from './components/updates/UpdateNotice'
import { Splitter } from './components/ui/Splitter'
import { ToastViewport } from './components/ui/Toast'
import { Sidebar } from './components/sidebar/Sidebar'
import { Home } from './routes/Home'
import { Notifications } from './routes/Notifications'
import { Settings } from './routes/Settings'
import { Workspace } from './routes/Workspace'
import { watchBotAccess } from './routes/settings/BotsPage'
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, sidebarMax, usePanels } from './state/panels'
import { useUi } from './state/ui'

export function App() {
  useEffect(watchBotAccess, [])
  const route = useUi((s) => s.route)
  const sidebarW = usePanels((s) => s.sidebarW)
  const rightW = usePanels((s) => s.rightW)
  const maxSidebar = usePanels(sidebarMax)
  const setSidebarW = usePanels((s) => s.setSidebarW)
  const setWithRight = usePanels((s) => s.setWithRight)
  const commit = usePanels((s) => s.commit)
  const leftHidden = usePanels((s) => s.leftHidden)
  const rightHidden = usePanels((s) => s.rightHidden)
  // The sidebars hide only on workspace routes: everywhere else the sidebar is the navigation.
  const isWorkspace = route.name === 'workspace'
  const withLeft = !(isWorkspace && leftHidden)
  const withRight = isWorkspace && !rightHidden

  // The right pane joins the grid on workspace routes; re-clamp so the center keeps its minimum.
  useEffect(() => {
    setWithRight(withRight)
  }, [withRight, setWithRight])

  // ⌘N is the sidebar's New: the prompt-first workspace modal. Ignored while any modal is open,
  // so the shortcut never remounts (and drops the prompt of) the modal being typed in.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'n' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const ui = useUi.getState()
      if (ui.modals.addWorkspaceFor !== null) return
      e.preventDefault()
      ui.openAddWorkspace(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Track count stays constant within a route family: hidden sides become 0px tracks
  // rather than vanishing, which is what lets the grid transition interpolate.
  const columns = isWorkspace
    ? [
        `${withLeft ? sidebarW : 0}px`,
        withLeft ? '8px' : '0px',
        'minmax(0, 1fr)',
        withRight ? '8px' : '0px',
        `${withRight ? rightW : 0}px`
      ].join(' ')
    : `${sidebarW}px 8px minmax(0, 1fr)`

  return (
    <>
      <div
        className="app-shell"
        data-left-hidden={withLeft ? 'false' : 'true'}
        data-right-hidden={withRight ? 'false' : 'true'}
        style={{ gridTemplateColumns: columns }}
      >
        <Sidebar />
        <Splitter
          label="Resize sidebar"
          panel="before"
          value={sidebarW}
          min={SIDEBAR_MIN}
          max={maxSidebar}
          defaultValue={SIDEBAR_DEFAULT}
          onChange={setSidebarW}
          onCommit={commit}
        />
        {route.name === 'home' && <Home />}
        {route.name === 'notifications' && <Notifications />}
        {route.name === 'settings' && <Settings />}
        {route.name === 'workspace' && <Workspace workspaceId={route.workspaceId} />}
      </div>
      <ModalHost />
      <CommandPalette />
      <div className="corner-stack">
        <UpdateNotice />
        <NotificationCards />
        <ToastViewport />
      </div>
    </>
  )
}
