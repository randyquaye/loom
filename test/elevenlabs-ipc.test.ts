import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, input: unknown) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      handlers.set(channel, fn)
    }
  }
}))

import { openDb } from '../src/main/db'
import type { IpcDeps } from '../src/main/ipc'
import { setTrustedOrigin } from '../src/main/ipc/index'
import { elevenlabsStatus, registerElevenLabsIpc } from '../src/main/ipc/elevenlabs'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import type { SecretPresence } from '../src/shared/ipc-contract'

setTrustedOrigin('file://')

function makeDeps(): IpcDeps {
  const dir = mkdtempSync(path.join(tmpdir(), 'loom-el-'))
  return {
    db: openDb(':memory:'),
    secrets: createSecretStore(path.join(dir, 'secrets.enc'), aesGcmCipher(randomBytes(32))),
    dataRoot: dir
  }
}

async function invoke<T>(channel: string, input: unknown): Promise<T> {
  const fn = handlers.get(channel)
  if (fn === undefined) throw new Error(`no handler registered for ${channel}`)
  return (await fn({ senderFrame: { url: 'file://index.html' } }, input)) as T
}

const KEY = 'sk-elevenlabs-abcdef123456'

describe('elevenlabs credential channels', () => {
  it('reports absent, then masked presence, then absent again', async () => {
    const deps = makeDeps()
    registerElevenLabsIpc(deps)

    expect(await invoke<SecretPresence>('elevenlabs:hasKey', undefined)).toEqual({
      present: false,
      masked: null
    })
    await invoke('elevenlabs:setKey', { value: KEY })
    const presence = await invoke<SecretPresence>('elevenlabs:hasKey', undefined)
    expect(presence.present).toBe(true)
    expect(presence.masked).not.toBeNull()
    expect(presence.masked).not.toContain(KEY)
    expect(presence.masked?.endsWith(KEY.slice(-4))).toBe(true)
    await invoke('elevenlabs:deleteKey', undefined)
    expect(await invoke<SecretPresence>('elevenlabs:hasKey', undefined)).toEqual({
      present: false,
      masked: null
    })
  })

  it('status probe follows the stored key', async () => {
    const deps = makeDeps()
    registerElevenLabsIpc(deps)

    expect(await elevenlabsStatus(deps)).toMatchObject({ state: 'needs-key' })
    await invoke('elevenlabs:setKey', { value: KEY })
    expect(await elevenlabsStatus(deps)).toEqual({ state: 'ready' })
  })
})
