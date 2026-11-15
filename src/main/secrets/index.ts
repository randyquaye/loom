import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { renameSync } from 'node:fs'
import { chmod, mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { SecretId } from '../../shared/models'

export interface Cipher {
  encrypt(plain: string): Buffer
  decrypt(cipher: Buffer): string
}

/** Production cipher: delegates to the macOS Keychain-backed Electron safeStorage. */
export function safeStorageCipher(safeStorage: {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(encrypted: Buffer): string
}): Cipher {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain encryption is unavailable; refusing to store secrets')
  }
  return {
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (buf) => safeStorage.decryptString(buf)
  }
}

/** Test cipher with the same envelope shape (iv | authTag | ciphertext). */
export function aesGcmCipher(key: Buffer): Cipher {
  return {
    encrypt(plain) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), enc])
    },
    decrypt(buf) {
      const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
      d.setAuthTag(buf.subarray(12, 28))
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
    }
  }
}

const blobSchema = z.record(z.string(), z.string())

/** Shown in Settings instead of a secret; never exposes more than the last four. */
export function maskSecret(value: string): string {
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`
}

/**
 * Stores the credentials Loom owns itself: provider API keys (gemini, qwen) and
 * integration keys (linear). Subscription credentials for codex/claude stay inside
 * their own CLIs and are never read by this app, and neither is gh's GitHub token.
 * Writes are serialized and atomic so a crash or concurrent set cannot erase keys.
 */
export function createSecretStore(file: string, cipher: Cipher) {
  let chain: Promise<unknown> = Promise.resolve()
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task)
    chain = next.catch(() => undefined)
    return next
  }

  async function load(): Promise<Record<string, string>> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw e
    }
    return blobSchema.parse(JSON.parse(raw))
  }

  async function save(blob: Record<string, string>, assertMayCommit?: () => void): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    let published = false
    try {
      const fh = await open(tmp, 'w', 0o600)
      try {
        await fh.writeFile(JSON.stringify(blob))
        await fh.sync()
      } finally {
        await fh.close()
      }
      await chmod(tmp, 0o600)
      // Authorization and atomic publication share one JS turn: no async rename gap.
      assertMayCommit?.()
      renameSync(tmp, file)
      published = true
    } finally {
      if (!published) await rm(tmp, { force: true })
    }
  }

  return {
    get(id: SecretId): Promise<string | null> {
      return this.getRaw(id)
    },
    set(id: SecretId, value: string): Promise<void> {
      return this.setRaw(id, value)
    },
    delete(id: SecretId): Promise<void> {
      return this.deleteRaw(id)
    },
    /** Namespaced raw access, used for environment variables beside the typed keys. */
    getRaw(key: string): Promise<string | null> {
      return serialized(async () => {
        const entry = (await load())[key]
        return entry === undefined ? null : cipher.decrypt(Buffer.from(entry, 'base64'))
      })
    },
    setRaw(key: string, value: string, assertMayCommit?: () => void): Promise<void> {
      return serialized(async () => {
        assertMayCommit?.()
        const blob = await load()
        blob[key] = cipher.encrypt(value).toString('base64')
        await save(blob, assertMayCommit)
      })
    },
    deleteRaw(key: string, assertMayCommit?: () => void): Promise<void> {
      return serialized(async () => {
        assertMayCommit?.()
        const blob = await load()
        delete blob[key]
        await save(blob, assertMayCommit)
      })
    },
    listRaw(prefix: string): Promise<string[]> {
      return serialized(async () =>
        Object.keys(await load())
          .filter((key) => key.startsWith(prefix))
          .sort()
      )
    }
  }
}

export type SecretStore = ReturnType<typeof createSecretStore>
