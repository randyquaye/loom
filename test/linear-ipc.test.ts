import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, input: unknown) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      handlers.set(channel, fn)
    }
  },
  dialog: { showSaveDialog: vi.fn() }
}))

// The network layer and the gh probe are replaced; the secret store stays real so the
// key round-trip, its masking and its deletion are actually exercised.
vi.mock('../src/main/integrations/linear/issues', () => ({ listAssignedIssues: vi.fn() }))
vi.mock('../src/main/integrations/github/gh', () => ({ ghAuthState: vi.fn() }))

import { openDb } from '../src/main/db'
import { ghAuthState } from '../src/main/integrations/github/gh'
import { LinearAuthError, LinearRequestError } from '../src/main/integrations/linear/client'
import { listAssignedIssues } from '../src/main/integrations/linear/issues'
import { registerIpc, setTrustedOrigin } from '../src/main/ipc/index'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import type { IntegrationsStatus, LinearIssueListResult, SecretPresence } from '../src/shared/ipc-contract'

const listIssues = vi.mocked(listAssignedIssues)
const authState = vi.mocked(ghAuthState)

const KEY = 'lin_api_secret_value_1234'

const ISSUE = {
  id: 'iss-1',
  identifier: 'ENG-123',
  title: 'Fix the login bug',
  url: 'https://linear.app/acme/issue/ENG-123',
  description: 'Repro steps.',
  stateName: 'In Progress',
  stateType: 'started' as const,
  teamKey: 'ENG',
  updatedAt: 1_762_338_030_000
}

beforeEach(() => {
  handlers.clear()
  listIssues.mockReset()
  authState.mockReset()
  authState.mockResolvedValue({ installed: true, account: 'randyquaye' })
  setTrustedOrigin('file://')
  const secrets = createSecretStore(
    path.join(mkdtempSync(path.join(tmpdir(), 'loom-linear-')), 'secrets.enc'),
    aesGcmCipher(randomBytes(32))
  )
  registerIpc({ db: openDb(':memory:'), secrets, dataRoot: tmpdir() })
})

async function call<T>(channel: string, input: unknown): Promise<T> {
  const fn = handlers.get(channel)
  if (fn === undefined) throw new Error(`no handler registered for ${channel}`)
  return (await fn({ senderFrame: { url: 'file://index.html' } }, input)) as T
}

function setKey(value: string) {
  return call<void>('linear:setKey', { value })
}

describe('linear key storage', () => {
  it('reports no key before one is stored, and masks it afterwards', async () => {
    expect(await call<SecretPresence>('linear:hasKey', undefined)).toEqual({
      present: false,
      masked: null
    })

    await setKey(KEY)

    // Only the last four may ever reach the renderer.
    expect(await call<SecretPresence>('linear:hasKey', undefined)).toEqual({
      present: true,
      masked: '••••1234'
    })
  })

  it('never returns the key itself over IPC', async () => {
    await setKey(KEY)
    const presence = await call<SecretPresence>('linear:hasKey', undefined)
    expect(JSON.stringify(presence)).not.toContain(KEY)
  })

  it('removes the key so the integration reports itself unconfigured again', async () => {
    await setKey(KEY)
    await call<void>('linear:deleteKey', undefined)
    expect(await call<SecretPresence>('linear:hasKey', undefined)).toEqual({
      present: false,
      masked: null
    })
  })

  it('rejects an empty key at the IPC boundary', async () => {
    await expect(setKey('')).rejects.toThrow()
  })
})

describe('linear:issues', () => {
  function issues(query: string | null = null) {
    return call<LinearIssueListResult>('linear:issues', { query })
  }

  it('reports needs-key rather than calling Linear when nothing is stored', async () => {
    const result = await issues()
    expect(result.kind).toBe('needs-key')
    if (result.kind === 'needs-key') expect(result.hint).toMatch(/Settings → API/)
    expect(listIssues).not.toHaveBeenCalled()
  })

  it('queries with the stored key and returns the issues', async () => {
    await setKey(KEY)
    listIssues.mockResolvedValue([ISSUE])

    await expect(issues()).resolves.toEqual({ kind: 'ok', issues: [ISSUE] })
    expect(listIssues).toHaveBeenCalledWith(KEY, null)
  })

  it('forwards the search query untouched', async () => {
    await setKey(KEY)
    listIssues.mockResolvedValue([])

    await issues('ENG-123')
    expect(listIssues).toHaveBeenCalledWith(KEY, 'ENG-123')
  })

  it('reports a rejected key as invalid-key, which Settings can act on', async () => {
    await setKey(KEY)
    listIssues.mockRejectedValue(new LinearAuthError('HTTP 401'))

    const result = await issues()
    expect(result.kind).toBe('invalid-key')
  })

  it('passes any other failure through with its code prefix', async () => {
    await setKey(KEY)
    listIssues.mockRejectedValue(new LinearRequestError('HTTP 500'))

    await expect(issues()).resolves.toEqual({
      kind: 'failed',
      message: 'LINEAR_REQUEST_FAILED: HTTP 500'
    })
  })

  it('rejects a query past the schema limit before reaching Linear', async () => {
    await setKey(KEY)
    await expect(issues('a'.repeat(201))).rejects.toThrow()
    expect(listIssues).not.toHaveBeenCalled()
  })
})

describe('integrations:status', () => {
  function status() {
    return call<IntegrationsStatus>('integrations:status', undefined)
  }

  it('reports Linear ready once a key is stored, and awaiting one before', async () => {
    expect((await status()).linear).toMatchObject({ state: 'needs-key' })
    await setKey(KEY)
    expect((await status()).linear).toEqual({ state: 'ready' })
  })

  it('probes both halves so a missing gh does not hide the Linear state', async () => {
    await setKey(KEY)
    authState.mockResolvedValue({ installed: false, account: null })

    const result = await status()
    expect(result.github.state).toBe('not-installed')
    expect(result.linear).toEqual({ state: 'ready' })
  })

  it('still reports GitHub when the Linear key read fails', async () => {
    authState.mockResolvedValue({ installed: true, account: 'randyquaye' })
    expect((await status()).github).toEqual({ state: 'ready', account: 'randyquaye' })
  })
})
