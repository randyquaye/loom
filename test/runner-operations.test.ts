import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runnerOperations } from '../src/main/runner/operations'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function fixture(downloadDir?: string) {
  let draining = false
  let ready = true
  const app = runnerOperations({
    ...(downloadDir === undefined ? {} : { downloadDir }),
    release: 'release-5',
    ready: () => ready && !draining,
    status: () => ({ draining, activeTurns: [], terminals: [], forwards: [], setup: [] }),
    setDraining: (value) => {
      draining = value
    },
    authorized: (token) => token === 'operator'
  })
  return {
    app,
    draining: () => draining,
    stop: () => {
      ready = false
    }
  }
}

describe('runner operations boundaries', () => {
  it('reports ready only while available and undrained without leaking operation details', async () => {
    const f = fixture()
    expect((await f.app.request('/healthz')).status).toBe(200)
    await f.app.request('/admin/drain', {
      method: 'POST',
      headers: { Authorization: 'Bearer operator', 'Content-Type': 'application/json' },
      body: JSON.stringify({ draining: true })
    })
    const drained = await f.app.request('/healthz')
    expect(drained.status).toBe(503)
    expect(await drained.text()).not.toContain('activeTurns')
    f.stop()
    expect((await f.app.request('/healthz')).status).toBe(503)
  })

  it('refuses uncredentialed or browser-origin drain and validates the whole request', async () => {
    const f = fixture()
    expect((await f.app.request('/admin/drain')).status).toBe(403)
    expect(
      (
        await f.app.request('/admin/drain', {
          method: 'POST',
          headers: { Authorization: 'Bearer operator', Origin: 'https://evil.example' }
        })
      ).status
    ).toBe(403)
    expect(
      (
        await f.app.request('/admin/drain', {
          method: 'POST',
          headers: { Authorization: 'Bearer operator', 'Content-Type': 'application/json' },
          body: '{"draining":"false"}'
        })
      ).status
    ).toBe(400)
    expect(f.draining()).toBe(false)
  })

  it('serves only the fixed desktop package, refusing directories and symlinks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-download-'))
    roots.push(root)
    const f = fixture(root)
    expect((await f.app.request('/download/Loom.dmg')).status).toBe(404)
    await writeFile(path.join(root, 'private.env'), 'secret')
    await symlink(path.join(root, 'private.env'), path.join(root, 'Loom.dmg'))
    expect((await f.app.request('/download/Loom.dmg')).status).toBe(404)
    await rm(path.join(root, 'Loom.dmg'))
    await writeFile(path.join(root, 'Loom.dmg'), 'desktop')
    const download = await f.app.request('/download/Loom.dmg')
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('desktop')
    expect((await f.app.request('/download/private.env')).status).toBe(404)
  })
})
