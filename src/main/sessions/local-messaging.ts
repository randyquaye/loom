import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import { getRequestListener } from '@hono/node-server'
import { createSessionMessaging } from './messaging'
import { receiveSessionMessage, sessionActivity, setSessionMessaging } from './service'

/** The desktop hosts the same messaging routes without starting a cloud runner. */
export async function startLocalSessionMessaging(db: Database.Database): Promise<() => void> {
  const runtime = db.prepare(
    'SELECT w.runtime FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?'
  )
  const messaging = createSessionMessaging({
    db,
    url: (sessionId) =>
      (runtime.get(sessionId) as { runtime: string } | undefined)?.runtime === 'machine' ? url : undefined,
    isAdmitted: (ownerId) => ownerId === null,
    active: (sessionId) => sessionActivity().bySession[sessionId] !== undefined,
    receive: (sessionId, input) => receiveSessionMessage(db, sessionId, input)
  })
  const server = createServer(getRequestListener(messaging.routes.fetch))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  server.on('error', (error) => console.warn('[loom] Session messaging:', error))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  setSessionMessaging(messaging)
  return () => {
    setSessionMessaging(null)
    server.close()
    server.closeAllConnections()
  }
}
