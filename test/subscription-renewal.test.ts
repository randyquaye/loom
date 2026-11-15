import { afterEach, expect, it, vi } from 'vitest'
import { renewingVault } from '../src/main/logins/renewal'
import { createLoginVault, type CodexLogin, type SealedStore } from '../src/main/logins/vault'

afterEach(() => vi.unstubAllGlobals())

const expired: CodexLogin = {
  provider: 'codex',
  accessToken: `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`,
  refreshToken: 'fixture-refresh',
  idToken: 'fixture-id',
  accountId: 'fixture-account'
}

it('keeps canonical credentials when account authority changes during a refused-refresh deletion', async () => {
  const values = new Map<string, string>()
  let beginDelete!: () => void
  const deleting = new Promise<void>((resolve) => {
    beginDelete = resolve
  })
  let finishDelete!: () => void
  const gate = new Promise<void>((resolve) => {
    finishDelete = resolve
  })
  const saved: SealedStore = {
    getRaw: async (key) => values.get(key) ?? null,
    setRaw: async (key, value) => {
      values.set(key, value)
    },
    async deleteRaw(key, guard) {
      beginDelete()
      await gate
      guard?.()
      values.delete(key)
    }
  }
  const vault = createLoginVault(saved)
  await vault.put('subscription_fixture', expired)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 401 }))
  )
  let revision = 1
  const unavailable = vi.fn()
  const renewing = renewingVault(vault, {
    guardLogin: () => {
      const captured = revision
      return () => {
        if (revision !== captured) throw new Error('Account changed')
      }
    },
    onInvalid: unavailable
  })
  const pending = renewing.get('subscription_fixture', 'codex')
  await deleting
  revision++
  finishDelete()
  await pending.catch(() => null)
  expect(await vault.get('subscription_fixture', 'codex')).toEqual(expired)
  expect(unavailable).not.toHaveBeenCalled()
})

it('reports a refused canonical refresh as unavailable after guarded removal', async () => {
  const values = new Map<string, string>()
  const saved: SealedStore = {
    getRaw: async (key) => values.get(key) ?? null,
    setRaw: async (key, value) => {
      values.set(key, value)
    },
    deleteRaw: async (key, guard) => {
      guard?.()
      values.delete(key)
    }
  }
  const vault = createLoginVault(saved)
  await vault.put('subscription_fixture', expired)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 401 }))
  )
  const guard = vi.fn()
  const unavailable = vi.fn()
  const renewing = renewingVault(vault, { guardLogin: () => guard, onInvalid: unavailable })
  expect(await renewing.get('subscription_fixture', 'codex')).toBeNull()
  expect(await vault.get('subscription_fixture', 'codex')).toBeNull()
  expect(unavailable).toHaveBeenCalledWith('subscription_fixture', 'codex', expect.any(Function))
  expect(guard).toHaveBeenCalled()
})

it.each([408, 429, 503])('retains the canonical account on temporary refresh status %s', async (status) => {
  const values = new Map<string, string>()
  const vault = createLoginVault({
    getRaw: async (key) => values.get(key) ?? null,
    setRaw: async (key, value) => {
      values.set(key, value)
    },
    deleteRaw: async (key) => {
      values.delete(key)
    }
  })
  await vault.put('subscription_fixture', expired)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status }))
  )
  const unavailable = vi.fn()
  const renewing = renewingVault(vault, { onInvalid: unavailable })
  expect(await renewing.get('subscription_fixture', 'codex')).toEqual(expired)
  expect(await vault.get('subscription_fixture', 'codex')).toEqual(expired)
  expect(unavailable).not.toHaveBeenCalled()
})

it('retains a successfully rotated refresh token when organization usage is disabled mid-refresh', async () => {
  const values = new Map<string, string>()
  const vault = createLoginVault({
    getRaw: async (key) => values.get(key) ?? null,
    setRaw: async (key, value, guard) => {
      guard?.()
      values.set(key, value)
    },
    deleteRaw: async (key, guard) => {
      guard?.()
      values.delete(key)
    }
  })
  await vault.put('subscription_fixture', expired)
  let started!: () => void
  const refreshing = new Promise<void>((resolve) => {
    started = resolve
  })
  let finish!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      started()
      return new Promise<Response>((resolve) => {
        finish = resolve
      })
    })
  )
  let enabled = true
  const renewing = renewingVault(vault, {
    guardLogin: () => () => {
      if (!enabled) throw new Error('Account disabled')
    },
    guardSuccess: () => () => {}
  })
  const pending = renewing.get('subscription_fixture', 'codex')
  await refreshing
  enabled = false
  finish(Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }))
  await pending
  expect((await vault.get('subscription_fixture', 'codex'))?.refreshToken).toBe('rotated-refresh')
})

it.each(['disconnect', 'reconnect'] as const)(
  'fences a successful refresh publication after %s starts during encrypted storage',
  async (change) => {
    const values = new Map<string, string>()
    let started!: () => void
    const publishing = new Promise<void>((resolve) => {
      started = resolve
    })
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    let publishedRotatedCredential = false
    const vault = createLoginVault({
      getRaw: async (key) => values.get(key) ?? null,
      async setRaw(key, value, guard) {
        if (value.includes('rotated-refresh')) {
          started()
          await gate
        }
        guard?.()
        if (value.includes('rotated-refresh')) publishedRotatedCredential = true
        values.set(key, value)
      },
      deleteRaw: async (key, guard) => {
        guard?.()
        values.delete(key)
      }
    })
    await vault.put('subscription_fixture', expired)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }))
    )
    const renewing = renewingVault(vault, { guardLogin: () => () => {}, guardSuccess: () => () => {} })
    const pending = renewing.get('subscription_fixture', 'codex').catch(() => null)
    await publishing
    const replacement = { ...expired, refreshToken: 'new-owner-refresh' }
    const changing =
      change === 'disconnect'
        ? renewing.remove('subscription_fixture', 'codex')
        : renewing.put('subscription_fixture', replacement)
    finish()
    await pending
    await changing
    expect(publishedRotatedCredential).toBe(false)
    expect(await vault.get('subscription_fixture', 'codex')).toEqual(
      change === 'disconnect' ? null : replacement
    )
  }
)

it('does not mark a concurrent reconnect invalid after an older refused refresh finishes deletion', async () => {
  const values = new Map<string, string>()
  let deleted!: () => void
  const removed = new Promise<void>((resolve) => {
    deleted = resolve
  })
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const vault = createLoginVault({
    getRaw: async (key) => values.get(key) ?? null,
    setRaw: async (key, value, guard) => {
      guard?.()
      values.set(key, value)
    },
    async deleteRaw(key, guard) {
      guard?.()
      values.delete(key)
      deleted()
      await gate
    }
  })
  await vault.put('subscription_fixture', expired)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 401 }))
  )
  let invalidated = false
  const renewing = renewingVault(vault, {
    guardLogin: () => () => {},
    onInvalid(_id, _provider, guard) {
      try {
        guard?.()
      } catch {
        return
      }
      invalidated = true
    }
  })
  const pending = renewing.get('subscription_fixture', 'codex')
  await removed
  const replacement = { ...expired, refreshToken: 'reconnected-refresh' }
  const reconnecting = renewing.put('subscription_fixture', replacement)
  finish()
  await pending
  await reconnecting
  expect(invalidated).toBe(false)
  expect(await vault.get('subscription_fixture', 'codex')).toEqual(replacement)
})
