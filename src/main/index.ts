import path from 'node:path'
import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { openDb } from './db'
import { missingChannelHandlers, registerIpc, setTrustedOrigin } from './ipc'
import { registerBackends } from './agents/wiring'
import { destroyAllTerminals, setTerminalSink } from './pty'
import { createSecretStore, safeStorageCipher } from './secrets'
import { setEnvSecretStore } from './env/vars'
import {
  setSessionSink,
  closeAllSessions,
  setLoomDataRoot,
  setLoomSkillDir,
  setQueueSink,
  setTitleSink
} from './sessions/service'
import { materializeLoomSkill } from './agents/skill'
import { openExternalSafe } from './shell/open'
import { setWorkspaceStateSink } from './workspace/bootstrap'
import {
  SESSION_EVENT_CHANNEL,
  SESSION_QUEUE_CHANNEL,
  SESSION_TITLE_CHANNEL,
  WORKSPACE_STATE_CHANNEL
} from '../shared/ipc-contract'

app.enableSandbox()

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0b0a10',
    titleBarStyle: 'hiddenInset',
    // Full-bleed panels: the lights are pinned here and cleared by the sidebar's top padding.
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.on('ready-to-show', () => win.show())
  setTerminalSink((channel, push) => {
    if (!win.isDestroyed()) win.webContents.send(channel, push)
  })
  setSessionSink((push) => {
    if (!win.isDestroyed()) win.webContents.send(SESSION_EVENT_CHANNEL, push)
  })
  setWorkspaceStateSink((push) => {
    if (!win.isDestroyed()) win.webContents.send(WORKSPACE_STATE_CHANNEL, push)
  })
  setQueueSink((push) => {
    if (!win.isDestroyed()) win.webContents.send(SESSION_QUEUE_CHANNEL, push)
  })
  setTitleSink((push) => {
    if (!win.isDestroyed()) win.webContents.send(SESSION_TITLE_CHANNEL, push)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafe(url)
    return { action: 'deny' }
  })

  const devOrigin = process.env.ELECTRON_RENDERER_URL
  const allowNavigate = (url: string): boolean =>
    !app.isPackaged && devOrigin !== undefined && url.startsWith(devOrigin)

  win.webContents.on('will-navigate', (event, url) => {
    if (allowNavigate(url)) return
    event.preventDefault()
    void openExternalSafe(url)
  })
  win.webContents.on('will-redirect', (event, url) => {
    event.preventDefault()
    void openExternalSafe(url)
  })

  if (!app.isPackaged && devOrigin) void win.loadURL(devOrigin)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app
    .whenReady()
    .then(() => {
      // LOOM_DATA_DIR lets e2e/screenshot runs target a known profile instead of
      // the unpackaged Electron default userData directory.
      const dataDir = process.env.LOOM_DATA_DIR ?? app.getPath('userData')
      setTrustedOrigin(app.isPackaged ? 'file://' : (process.env.ELECTRON_RENDERER_URL ?? 'file://'))
      const db = openDb(path.join(dataDir, 'loom.db'))
      const secrets = createSecretStore(path.join(dataDir, 'secrets.enc'), safeStorageCipher(safeStorage))
      setEnvSecretStore(secrets)
      setLoomDataRoot(dataDir)
      registerIpc({ db, secrets, dataRoot: dataDir })
      registerBackends(secrets)
      // The bundled skill plugin is written under the data root before any
      // claude session spawns; a failure must not block startup.
      void materializeLoomSkill(dataDir)
        .then(setLoomSkillDir)
        .catch((err: unknown) => console.warn('[loom] skill materialize failed:', err))
      if (!app.isPackaged) {
        const missing = missingChannelHandlers()
        if (missing.length > 0) console.warn('[loom] ipc channels without handlers:', missing)
      }
      createWindow()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((error: unknown) => {
      dialog.showErrorBox('Loom failed to start', String(error))
      app.quit()
    })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    closeAllSessions()
    destroyAllTerminals()
  })
}
