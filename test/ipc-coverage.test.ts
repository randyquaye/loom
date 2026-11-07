import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

const registered: string[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, _fn: unknown): void => {
      registered.push(channel)
    }
  },
  dialog: { showSaveDialog: vi.fn() }
}))

import { registerIpc } from '../src/main/ipc/index'
import { openDb } from '../src/main/db'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import { ipcSchemas } from '../src/shared/ipc-contract'
import { EFFORTS } from '../src/shared/models'

describe('ipc coverage', () => {
  it('registers a handler for every channel in the contract', () => {
    const db = openDb(':memory:')
    const secrets = createSecretStore(
      path.join(mkdtempSync(path.join(tmpdir(), 'loom-ipc-')), 'secrets.enc'),
      aesGcmCipher(randomBytes(32))
    )
    registerIpc({ db, secrets, dataRoot: tmpdir() })
    expect([...registered].sort()).toEqual(Object.keys(ipcSchemas).sort())
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
