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
import type { SecretPresence, SingleUseTokenResult } from '../src/shared/ipc-contract'

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

describe('elevenlabs stt token', () => {
  it('reports needs-key without touching the network', async () => {
    const deps = makeDeps()
    registerElevenLabsIpc(deps)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    expect(await invoke<SingleUseTokenResult>('elevenlabs:sttToken', undefined)).toEqual({ kind: 'needs-key' })
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('mints a single-use token with the stored key and never returns the key', async () => {
    const deps = makeDeps()
    registerElevenLabsIpc(deps)
    await invoke('elevenlabs:setKey', { value: KEY })
    const fetchSpy = vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
      expect(String(url)).toContain('/v1/single-use-token/realtime_scribe')
      expect(init?.headers?.['xi-api-key']).toBe(KEY)
      return { ok: true, json: async () => ({ token: 'single-use-token' }) }
    })
    vi.stubGlobal('fetch', fetchSpy)

    expect(await invoke<SingleUseTokenResult>('elevenlabs:sttToken', undefined)).toEqual({
      kind: 'ok',
      token: 'single-use-token'
    })
    vi.unstubAllGlobals()
  })

  it('surfaces provider failures without throwing', async () => {
    const deps = makeDeps()
    registerElevenLabsIpc(deps)
    await invoke('elevenlabs:setKey', { value: KEY })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }))
    )

    expect(await invoke<SingleUseTokenResult>('elevenlabs:sttToken', undefined)).toMatchObject({ kind: 'error' })
    vi.unstubAllGlobals()
  })

  it('mints the tts_websocket scope for speech output', async () => {
    const deps = makeDeps()
    registerElevenLabsIpc(deps)
    await invoke('elevenlabs:setKey', { value: KEY })
    const fetchSpy = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain('/v1/single-use-token/tts_websocket')
      return { ok: true, json: async () => ({ token: 'tts-token' }) }
    })
    vi.stubGlobal('fetch', fetchSpy)

    expect(await invoke<SingleUseTokenResult>('elevenlabs:ttsToken', undefined)).toEqual({
      kind: 'ok',
      token: 'tts-token'
    })
    vi.unstubAllGlobals()
  })
})
