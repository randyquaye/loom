import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const registered: string[] = []
const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, input: unknown) => unknown): void => {
      registered.push(channel)
      handlers.set(channel, fn)
    }
  },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(async (channel: string, input: unknown) =>
      handlers.get(channel)!({ senderFrame: { url: 'file://loom' } }, input)
    )
  },
  dialog: { showSaveDialog: vi.fn() }
}))

import { registerIpc } from '../src/main/ipc/index'
import { setTrustedOrigin } from '../src/main/ipc/handle'
import * as sessions from '../src/main/sessions/service'
import { contextBridge } from 'electron'
import { openDb } from '../src/main/db'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import { ipcSchemas, type LoomApi } from '../src/shared/ipc-contract'
import type { QuestionAnswer } from '../src/shared/events'
import { EFFORTS } from '../src/shared/models'

describe('ipc coverage', () => {
  beforeEach(() => {
    vi.resetModules()
    registered.length = 0
    handlers.clear()
    const db = openDb(':memory:')
    const secrets = createSecretStore(
      path.join(mkdtempSync(path.join(tmpdir(), 'loom-ipc-')), 'secrets.enc'),
      aesGcmCipher(randomBytes(32))
    )
    registerIpc({ db, secrets, dataRoot: tmpdir() })
  })

  it('registers a handler for every channel in the contract', () => {
    expect([...registered].sort()).toEqual(Object.keys(ipcSchemas).sort())
  })

  it('routes preload answers through validation before calling the session service', async () => {
    setTrustedOrigin('file://')
    const reply = vi.spyOn(sessions, 'answerQuestion').mockResolvedValue(undefined)
    try {
      await import('../src/preload/index')
      const api = vi.mocked(contextBridge.exposeInMainWorld).mock.calls.at(-1)![1] as LoomApi
      const answer = { requestId: 'request', answers: { pick: ['selected'] } }
      await api.sessions.answerQuestion('session', answer)
      expect(reply).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'session', answer)
      const malformed = { ...answer, answers: { pick: 'unstructured' } } as unknown as QuestionAnswer
      await expect(api.sessions.answerQuestion('session', malformed)).rejects.toThrow()
      expect(reply).toHaveBeenCalledTimes(1)
    } finally {
      reply.mockRestore()
    }
  })
  it('routes steering through the validated bridge without using interrupt delivery', async () => {
    setTrustedOrigin('file://')
    const steer = vi.spyOn(sessions, 'steerTurn').mockResolvedValue(undefined)
    try {
      await import('../src/preload/index')
      const api = vi.mocked(contextBridge.exposeInMainWorld).mock.calls.at(-1)![1] as LoomApi
      await api.sessions.steer('session', 'guidance', [])
      expect(steer).toHaveBeenCalledWith(expect.anything(), 'session', 'guidance', [], [tmpdir()])
      await expect(api.sessions.steer('session', '', [])).rejects.toThrow()
      expect(steer).toHaveBeenCalledTimes(1)
    } finally {
      steer.mockRestore()
    }
  })
})

describe('effort boundary', () => {
  // fitEffort defaults a new session to the MIDDLE of a model's effort list, so for the
  // codex catalog that is `xhigh`. A session-create gate narrower than EFFORTS therefore
  // rejects the default choice outright; this pins the gate to the full ladder.
  it('accepts every effort the model catalogs can offer on create and fork', () => {
    for (const effort of EFFORTS) {
      expect(() =>
        ipcSchemas['sessions:create'].parse({
          workspaceId: 'w1',
          backend: 'codex',
          model: 'gpt-6.1-sol',
          effort,
          title: 't'
        })
      ).not.toThrow()
      expect(() =>
        ipcSchemas['sessions:fork'].parse({
          workspaceId: 'w1',
          backend: 'codex',
          model: 'gpt-6.1-sol',
          effort,
          sourceSessionId: 's1'
        })
      ).not.toThrow()
    }
  })
})
