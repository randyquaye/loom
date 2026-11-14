import path from 'node:path'
import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { openDb } from './db'
import { listProjects } from './db/repos/projects'
import { migrateProjectInstructions } from './instructions/migrate-general'
import { openCloudAccount, type CloudAccount } from './cloud/account'
import { createCloudRoute, type CloudRoute } from './cloud/route'
import { setCloudAccount, setCloudStatus } from './cloud/status'
import {
  missingChannelHandlers,
  registerIpc,
  setIpcRouter,
  setNotificationSink,
  setTrustedOrigin
} from './ipc'
import { registerBackends } from './agents/wiring'
import { destroyAllTerminals, setTerminalSink } from './pty'
import { createSecretStore, safeStorageCipher, type SecretStore } from './secrets'
import { setEnvSecretStore } from './env/vars'
import {
  setSessionSink,
  setActivitySink,
  closeAllSessions,
  setLoomDataRoot,
  setQueueSink,
  setTitleSink
} from './sessions/service'
import { openExternalSafe } from './shell/open'
import { setWorkspaceStateSink } from './workspace/bootstrap'
import {
  SESSION_EVENT_CHANNEL,
  SESSION_ACTIVITY_CHANNEL,
  CLOUD_STATUS_CHANNEL,
  SESSION_QUEUE_CHANNEL,
  SESSION_TITLE_CHANNEL,
  WORKSPACE_STATE_CHANNEL
} from '../shared/ipc-contract'
import { NOTIFICATION_CHANNEL } from '../shared/notifications'

app.enableSandbox()

let mainWindow: BrowserWindow | null = null
let cloud: CloudRoute | null = null
let account: CloudAccount | null = null

function toWindow(channel: string, payload: unknown): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

/** This Mac's live updates. With a runner configured they are merged with the runner's first. */
function emit(channel: string, payload: unknown): void {
  if (cloud === null) toWindow(channel, payload)
  else cloud.fromLocal(channel, payload)
}

function wireLiveUpdates(): void {
  setTerminalSink((channel, push) => emit(channel, push))
  setSessionSink((push) => emit(SESSION_EVENT_CHANNEL, push))
  setActivitySink((push) => emit(SESSION_ACTIVITY_CHANNEL, push))
  setWorkspaceStateSink((push) => emit(WORKSPACE_STATE_CHANNEL, push))
  setQueueSink((push) => emit(SESSION_QUEUE_CHANNEL, push))
  setTitleSink((push) => emit(SESSION_TITLE_CHANNEL, push))
  setNotificationSink((notification) => emit(NOTIFICATION_CHANNEL, notification))
}

/**
 * Following a runner is opt-in: until an address is set, in Settings or by LOOM_RUNNER_URL,
 * no route exists and Loom is the local app it always was. A cloud that cannot be set up is
 * reported and left off; it never stops the local app from starting.
 */
async function openCloud(
  db: ReturnType<typeof openDb>,
  dataRoot: string,
  secrets: SecretStore
): Promise<void> {
  try {
    account = await openCloudAccount({
      vault: secrets,
      environment: { url: process.env.LOOM_RUNNER_URL, token: process.env.LOOM_RUNNER_TOKEN },
      development: !app.isPackaged,
      openBrowser: (url) => void openExternalSafe(url),
      follow(url, auth) {
        const route = createCloudRoute({ db, dataRoot, url, ...auth, toWindow })
        cloud = route
        setIpcRouter(route.route)
        return {
          reconnect: () => route.reconnect(),
          close() {
            route.close()
            cloud = null
            setIpcRouter(null)
            setCloudStatus({ state: 'off' })
            toWindow(CLOUD_STATUS_CHANNEL, { state: 'off' })
          }
        }
      }
    })
    setCloudAccount(account)
  } catch (error) {
    console.warn('[loom] Cloud is unavailable:', error)
  }
}

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
  mainWindow = win
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
    .then(async () => {
      // LOOM_DATA_DIR lets e2e/screenshot runs target a known profile instead of
      // the unpackaged Electron default userData directory.
      const dataDir = process.env.LOOM_DATA_DIR ?? app.getPath('userData')
      setTrustedOrigin(app.isPackaged ? 'file://' : (process.env.ELECTRON_RENDERER_URL ?? 'file://'))
      const db = openDb(path.join(dataDir, 'loom.db'))
      const secrets = createSecretStore(path.join(dataDir, 'secrets.enc'), safeStorageCipher(safeStorage))
      setEnvSecretStore(secrets)
      setLoomDataRoot(dataDir)
      for (const project of listProjects(db)) {
        await migrateProjectInstructions(db, dataDir, project.id).catch((error: unknown) =>
          console.warn(`[loom] General instructions need recovery for ${project.name}:`, error)
        )
      }
      registerIpc({ db, secrets, dataRoot: dataDir })
      registerBackends(secrets)
      wireLiveUpdates()
      await openCloud(db, dataDir, secrets)
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
    // Only the connection ends: what runs on the runner keeps running.
    account?.close()
  })
}
