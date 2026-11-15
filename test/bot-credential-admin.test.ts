import { generateKeyPairSync, randomBytes } from 'node:crypto'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotGithub } from '../src/main/bots/github'
import { startLogins, type SignInRun } from '../src/main/logins/service'
import { createLoginVault } from '../src/main/logins/vault'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'

const staging = vi.hoisted(() => ({ file: '', started: () => {}, wait: Promise.resolve() }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof files>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (args[0] === staging.file) {
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync()
          staging.started()
          await staging.wait
        })
      }
      return handle
    }
  }
})

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  staging.file = ''
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function storeFixture() {
  const root = await files.mkdtemp(path.join(tmpdir(), 'loom-bot-admin-'))
  cleanup.push(() => files.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'credentials.enc')
  return { root, file, store: createSecretStore(file, aesGcmCipher(randomBytes(32))) }
}

/** Pause after the encrypted staging file has actually reached disk, before publication. */
function stagedWrite(file: string) {
  const staged = deferred<void>()
  const release = deferred<void>()
  staging.file = `${file}.tmp`
  staging.started = () => staged.resolve()
  staging.wait = release.promise
  return { staged: staged.promise, release: () => release.resolve() }
}

describe('bot credential administration publication', () => {
  it('preserves a canonical credential when a pending deletion loses administrator authority', async () => {
    const f = await storeFixture()
    await f.store.setRaw('bot-credential', 'current owner credential')
    let authorized = true
    const gate = stagedWrite(f.file)
    const deleting = f.store.deleteRaw('bot-credential', () => {
      if (!authorized) throw new Error('Owner authority revoked')
    })
    const result = deleting.then(
      () => 'deleted',
      (error: Error) => error.message
    )
    await gate.staged
    authorized = false
    gate.release()
    expect(await result).toMatch(/revoked/)
    expect(await f.store.getRaw('bot-credential')).toBe('current owner credential')
  })

  it('retains the previous canonical secret and removes staged ciphertext when authority ends before publication', async () => {
    const f = await storeFixture()
    await f.store.setRaw('bot-credential', 'previous')
    let authorized = true
    const gate = stagedWrite(f.file)
    const saving = f.store.setRaw('bot-credential', 'unauthorized replacement', () => {
      if (!authorized) throw new Error('Owner authority revoked')
    })
    const result = saving.then(
      () => 'saved',
      (error: Error) => error.message
    )
    await gate.staged
    authorized = false
    gate.release()
    expect(await result).toMatch(/revoked/)
    expect(await f.store.getRaw('bot-credential')).toBe('previous')
    await expect(files.stat(`${f.file}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
    await f.store.setRaw('another-owner', 'new authorized value')
    expect(await f.store.getRaw('another-owner')).toBe('new authorized value')
    expect((await files.stat(f.file)).mode & 0o777).toBe(0o600)
  })

  it('propagates current owner authority through Claude service and renewal wrappers into the real vault commit', async () => {
    const f = await storeFixture()
    const vault = createLoginVault(f.store)
    await vault.put('bot', { provider: 'claude', accessToken: 'previous' })
    const logins = await startLogins({
      key: randomBytes(32),
      store: f.store,
      host: '127.0.0.1',
      port: 0,
      fronts: { claude: 'https://claude.test', codex: 'https://codex.test', github: 'https://github.test' },
      isAdmitted: () => true,
      ownerAt: () => null,
      homeOf: (id) => path.join(f.root, 'homes', id)
    })
    cleanup.push(() => logins.close())
    let authorized = true
    const gate = stagedWrite(f.file)
    const saving = logins.connectClaude('bot', 'sk-ant-fixture-replacement-1234', () => {
      if (!authorized) throw new Error('Owner authority revoked')
    })
    const result = saving.then(
      () => 'saved',
      (error: Error) => error.message
    )
    await gate.staged
    authorized = false
    gate.release()
    expect(await result).toMatch(/revoked/)
    expect((await vault.get('bot', 'claude'))?.accessToken).toBe('previous')
  })

  it('rejects a late successful Codex device login after its initiating administrator loses authority', async () => {
    const f = await storeFixture()
    const vault = createLoginVault(f.store)
    await vault.put('bot', {
      provider: 'codex',
      accessToken: 'previous',
      refreshToken: 'old-refresh',
      idToken: 'old-id',
      accountId: 'old-account'
    })
    const completed = deferred<number>()
    const run: SignInRun = {
      home: path.join(f.root, 'login'),
      output: (async function* () {
        yield 'https://auth.openai.com/codex/device\nABCD-EFGH\n'
      })(),
      done: completed.promise,
      cancel: () => completed.resolve(1),
      discard: vi.fn(async () => {})
    }
    await files.mkdir(path.join(run.home, '.codex'), { recursive: true })
    await files.writeFile(
      path.join(run.home, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'replacement',
          refresh_token: 'replacement-refresh',
          id_token: 'replacement-id',
          account_id: 'replacement-account'
        }
      })
    )
    const logins = await startLogins({
      key: randomBytes(32),
      store: f.store,
      host: '127.0.0.1',
      port: 0,
      fronts: { claude: 'https://claude.test', codex: 'https://codex.test', github: 'https://github.test' },
      isAdmitted: () => true,
      ownerAt: () => null,
      homeOf: (id) => path.join(f.root, 'homes', id),
      signInToCodex: async () => run
    })
    cleanup.push(() => logins.close())
    let authorized = true
    await logins.connectCodex('bot', () => {
      if (!authorized) throw new Error('Owner authority revoked')
    })
    authorized = false
    completed.resolve(0)
    await expect.poll(() => vi.mocked(run.discard).mock.calls.length).toBe(1)
    expect((await vault.get('bot', 'codex'))?.accessToken).toBe('previous')
    expect((await logins.status('bot')).attempts?.codex?.state).toBe('failed')
  })

  it('does not publish GitHub installation credentials after authority changes during encrypted staging', async () => {
    const f = await storeFixture()
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const original = { appId: '123', installationId: '456', privateKey }
    const github = createBotGithub({
      store: f.store,
      isBot: () => true,
      isAdmitted: () => true,
      repositories: () => ['example/repo']
    })
    await github.configure('bot', original)
    let authorized = true
    const gate = stagedWrite(f.file)
    const saving = github.configure('bot', { ...original, installationId: '789' }, () => {
      if (!authorized) throw new Error('Owner authority revoked')
    })
    const result = saving.then(
      () => 'saved',
      (error: Error) => error.message
    )
    await gate.staged
    authorized = false
    gate.release()
    expect(await result).toMatch(/revoked/)
    expect(JSON.parse((await f.store.getRaw('user::bot::bot-github'))!)).toMatchObject({
      installationId: '456'
    })
  })
})
