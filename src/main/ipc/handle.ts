import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { dispatch, onChannelRegistered } from './registry'

export { handle, missingChannelHandlers, secretPresence, type IpcDeps } from './registry'

let trustedOrigin: string | null = null

/** Set once at startup: the dev server origin, or file:// when packaged. */
export function setTrustedOrigin(origin: string): void {
  trustedOrigin = origin
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? ''
  if (trustedOrigin === null || !url.startsWith(trustedOrigin)) {
    throw new Error(`ipc rejected: untrusted sender frame ${url}`)
  }
}

export type IpcRouter = (channel: string, input: unknown) => unknown

let router: IpcRouter = dispatch

/**
 * Installed while a runner is followed: it sends calls about cloud workspaces there. Null puts
 * back the local answers alone.
 */
export function setIpcRouter(next: IpcRouter | null): void {
  router = next ?? dispatch
}

// Loading this module is what makes a process the desktop: from here on every registered
// handler is exposed to the window, behind the trusted-sender check.
onChannelRegistered((channel) => {
  ipcMain.handle(channel, (event, input: unknown) => {
    assertTrustedSender(event)
    return router(channel, input)
  })
})
