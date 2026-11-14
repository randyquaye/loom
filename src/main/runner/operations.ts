import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { z } from 'zod'

export interface DrainStatus {
  draining: boolean
  activeTurns: Array<{ sessionId: string; workspaceId: string }>
  terminals: Array<{ workspaceId: string; count: number }>
  forwards: string[]
  setup: string[]
}

interface OperationsOptions {
  downloadDir?: string
  release: string
  ready(): boolean
  status(): DrainStatus
  setDraining(value: boolean): void
  authorized(token: string): boolean
}

/** Small public readiness/download surface; operational details require an owner's credential. */
export function runnerOperations(options: OperationsOptions): Hono {
  const app = new Hono()
  app.get('/healthz', (c) => {
    c.header('Cache-Control', 'no-store')
    const ready = options.ready()
    return c.json({ ready, release: options.release }, ready ? 200 : 503)
  })
  app.use('/admin/*', async (c, next) => {
    const header = c.req.header('Authorization') ?? ''
    if (
      c.req.header('Origin') !== undefined ||
      !header.startsWith('Bearer ') ||
      !options.authorized(header.slice(7))
    )
      return c.text('Forbidden', 403)
    c.header('Cache-Control', 'no-store')
    await next()
  })
  app.get('/admin/drain', (c) => c.json(options.status()))
  app.post('/admin/drain', async (c) => {
    const input = z
      .object({ draining: z.boolean() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.text('Expected a draining boolean', 400)
    options.setDraining(input.data.draining)
    return c.json(options.status())
  })
  app.get('/download', (c) => c.redirect('/download/Loom.dmg'))
  app.get('/download/Loom.dmg', async (c) => {
    if (options.downloadDir === undefined) return c.notFound()
    const file = path.join(options.downloadDir, 'Loom.dmg')
    const stat = await lstat(file).catch(() => null)
    if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return c.notFound()
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="Loom.dmg"',
        'Content-Length': String(stat.size),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache'
      }
    })
  })
  return app
}
