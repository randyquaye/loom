import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'

describe('secret store', () => {
  async function makeStore() {
    const dir = await mkdtemp(path.join(tmpdir(), 'loom-secrets-'))
    return { dir, store: createSecretStore(path.join(dir, 'secrets.enc'), aesGcmCipher(randomBytes(32))) }
  }

  it('round-trips a value', async () => {
    const { store } = await makeStore()
    await store.set('gemini', 'sk-live-abc123')
    expect(await store.get('gemini')).toBe('sk-live-abc123')
  })

  it('returns null for absent providers', async () => {
    const { store } = await makeStore()
    expect(await store.get('qwen')).toBeNull()
  })

  it('deletes values', async () => {
    const { store } = await makeStore()
    await store.set('qwen', 'k')
    await store.delete('qwen')
    expect(await store.get('qwen')).toBeNull()
  })

  it('never writes plaintext to disk', async () => {
    const { dir, store } = await makeStore()
    await store.set('gemini', 'supersecret-value-xyz')
    const raw = await readFile(path.join(dir, 'secrets.enc'), 'utf8')
    expect(raw).not.toContain('supersecret-value-xyz')
  })

  it('keeps every key under concurrent sets', async () => {
    const { store } = await makeStore()
    await Promise.all([store.set('gemini', 'g-value'), store.set('qwen', 'q-value')])
    expect(await store.get('gemini')).toBe('g-value')
    expect(await store.get('qwen')).toBe('q-value')
  })
})
