import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGithubConnect } from '../src/main/logins/github-connect'
import { secureHome } from '../src/main/logins/homes'
import { renewingVault } from '../src/main/logins/renewal'
import { startLogins, type SignInRun } from '../src/main/logins/service'
import { createLoginVault, type GithubLogin, type SealedStore } from '../src/main/logins/vault'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function store(): SealedStore {
  const values = new Map<string, string>()
  return {
    getRaw: async (key) => values.get(key) ?? null,
    setRaw: async (key, value) => {
      values.set(key, value)
    },
    deleteRaw: async (key) => {
      values.delete(key)
    }
  }
}

const githubLogin: GithubLogin = {
  provider: 'github',
  accessToken: 'ghu_test',
  refreshToken: 'ghr_test',
  expiresAt: Date.now() + 3600000,
  refreshExpiresAt: Date.now() + 86400000,
  account: 'ada',
  installed: true,
  clientId: 'app-client'
}

describe('GitHub browser authorization ownership', () => {
  async function fixture() {
    const vault = createLoginVault(store())
    let exchanges = 0
    const flow = createGithubConnect({
      publicUrl: 'https://pilot.example.com',
      vault,
      isAdmitted: () => true,
      onConnected: async () => {},
      client: {
        clientId: 'app-client',
        installUrl: 'https://github.com/apps/loom/installations/new',
        authorizeUrl: (state) => `https://github.com/login/oauth/authorize?state=${state}`,
        exchange: async () => {
          exchanges++
          return githubLogin
        },
        renew: async () => githubLogin,
        installed: async () => true
      }
    })
    const begun = flow.begin('ada', 'http://127.0.0.1:53211/callback')
    const start = await flow.routes.request(begun.url)
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const callback = `/auth/github/callback?state=${state}&code=github-code`
    return { vault, flow, cookie, callback, exchanges: () => exchanges }
  }

  it('requires the initiating browser and consumes authorization exactly once', async () => {
    const fx = await fixture()
    expect((await fx.flow.routes.request(fx.callback)).status).toBe(400)
    expect(fx.exchanges()).toBe(0)
    expect(await fx.vault.get('ada', 'github')).toBeNull()
    const back = await fx.flow.routes.request(fx.callback, { headers: { cookie: fx.cookie } })
    expect(back.status).toBe(302)
    // GitHub's answer is held until the desktop that started the connection claims it.
    expect(await fx.vault.get('ada', 'github')).toBeNull()
    await fx.flow.finish('ada', new URL(back.headers.get('location')!).searchParams.get('claim')!)
    expect((await fx.vault.get('ada', 'github'))?.account).toBe('ada')
    expect(await fx.vault.get('grace', 'github')).toBeNull()
    expect((await fx.flow.routes.request(fx.callback, { headers: { cookie: fx.cookie } })).status).toBe(400)
    expect(fx.exchanges()).toBe(1)
  })

  it('cannot restore a login after disconnect invalidates its pending browser attempt', async () => {
    const fx = await fixture()
    fx.flow.cancel('ada')
    expect((await fx.flow.routes.request(fx.callback, { headers: { cookie: fx.cookie } })).status).toBe(400)
    expect(await fx.vault.get('ada', 'github')).toBeNull()
  })
})

describe('cloud credential files', () => {
  it('updates a mounted inode and never adopts credentials written inside a workspace home', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-credentials-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const home = path.join(root, 'homes', 'ada')
    const vault = createLoginVault(store())
    const options = {
      key: randomBytes(32),
      vault,
      codexUrl: 'https://pilot.example.com:8444',
      githubUrl: 'https://pilot.example.com',
      userId: 'ada',
      homePath: home
    }
    const real = {
      provider: 'codex' as const,
      accessToken: 'real',
      refreshToken: 'refresh',
      idToken: 'id',
      accountId: 'account'
    }
    await vault.put('ada', real)
    await secureHome(options)
    const mounted = await open(path.join(root, 'login-files', 'ada', '.codex', 'auth.json'), 'r')
    cleanup.push(() => mounted.close())
    await vault.remove('ada', 'codex')
    await secureHome(options)
    expect(JSON.parse(await mounted.readFile('utf8'))).not.toHaveProperty('tokens')
    await writeFile(
      path.join(home, '.codex', 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'smuggled',
          refresh_token: 'refresh',
          id_token: 'id',
          account_id: 'account'
        }
      })
    )
    await secureHome(options)
    expect(await vault.get('ada', 'codex')).toBeNull()
    expect(await readFile(path.join(home, '.codex', 'auth.json'), 'utf8')).not.toContain('smuggled')
  })
})

describe('renewal during disconnect', () => {
  it('shares one refresh and cannot save its result after the login was removed', async () => {
    const vault = createLoginVault(store())
    await vault.put('ada', { ...githubLogin, expiresAt: 0 })
    let finish!: (login: GithubLogin) => void
    let calls = 0
    const renewing = renewingVault(vault, {
      github: {
        clientId: 'app-client',
        installUrl: '',
        authorizeUrl: () => '',
        exchange: async () => githubLogin,
        installed: async () => true,
        renew: () => {
          calls++
          return new Promise((resolve) => {
            finish = resolve
          })
        }
      }
    })
    const first = renewing.get('ada', 'github')
    const second = renewing.get('ada', 'github')
    await expect.poll(() => calls).toBe(1)
    await renewing.remove('ada', 'github')
    finish({ ...githubLogin, accessToken: 'renewed' })
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(await vault.get('ada', 'github')).toBeNull()
  })
})

describe('Codex reconnect outcomes', () => {
  it('keeps an existing login when replacement fails and reports failure separately', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-reconnect-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const saved = store()
    const vault = createLoginVault(saved)
    await vault.put('ada', {
      provider: 'codex',
      accessToken: 'existing',
      refreshToken: 'refresh',
      idToken: 'id',
      accountId: 'account'
    })
    let finish!: (code: number) => void
    const run: SignInRun = {
      home: path.join(root, 'sign-in'),
      output: (async function* () {
        yield 'https://auth.openai.com/codex/device\nABCD-EFGH\n'
      })(),
      done: new Promise<number>((resolve) => {
        finish = resolve
      }),
      cancel: () => finish(1),
      discard: async () => {}
    }
    await mkdir(run.home, { recursive: true })
    const logins = await startLogins({
      key: randomBytes(32),
      store: saved,
      host: '127.0.0.1',
      port: 0,
      fronts: {
        claude: 'https://pilot.example.com:8443',
        codex: 'https://pilot.example.com:8444',
        github: 'https://pilot.example.com'
      },
      isAdmitted: () => true,
      ownerAt: () => 'ada',
      homeOf: (user) => path.join(root, 'homes', user),
      signInToCodex: async () => run
    })
    cleanup.push(() => logins.close())
    const instructions = await logins.connectCodex('ada')
    expect((await logins.status('ada')).attempts?.codex?.code).toBe(instructions.code)
    finish(1)
    await expect.poll(async () => (await logins.status('ada')).attempts?.codex?.state).toBe('failed')
    expect((await logins.status('ada')).codex).toBe(true)
    expect((await vault.get('ada', 'codex'))?.accessToken).toBe('existing')
  })
})
