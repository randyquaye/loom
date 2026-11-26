import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSignInConfig } from '../src/main/runner/sign-in-config'

let directory: string
let env: NodeJS.ProcessEnv
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'loom-managed-config-'))
  const keyFile = path.join(directory, 'runner.pem')
  await writeFile(keyFile, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }))
  env = {
    LOOM_SIGN_IN_MODE: 'managed',
    LOOM_PUBLIC_URL: 'https://pilot.loombox.xyz',
    LOOM_GOOGLE_CLIENT_ID: '123-managed.apps.googleusercontent.com',
    LOOM_GOOGLE_CLIENT_SECRET: 'test-secret',
    LOOM_OWNER_EMAIL: 'owner@gmail.com',
    LOOM_RUNNER_SIGNING_KEY_FILE: keyFile,
    LOOM_TRANSPORT_PROOF_FILE: path.join(directory, 'transport.json')
  }
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

describe('production runner sign-in configuration', () => {
  it('starts managed authentication without a company domain, preserving configured owner identity', async () => {
    const config = await readSignInConfig(env)
    expect(config).toMatchObject({ mode: 'managed', domains: [], ownerEmail: 'owner@gmail.com' })
  })

  it('does not silently turn off authentication when managed settings lack Google credentials', async () => {
    delete env.LOOM_GOOGLE_CLIENT_ID
    await expect(readSignInConfig(env)).rejects.toThrow()
  })

  it.each([
    'https://runner.example.com',
    'https://pilot.loombox.xyz.evil.com',
    'https://pilot.loombox.xyz:444'
  ])('refuses managed authentication on %s', async (url) => {
    env.LOOM_PUBLIC_URL = url
    await expect(readSignInConfig(env)).rejects.toThrow()
  })

  it('keeps company domains mandatory unless managed mode is explicitly selected', async () => {
    delete env.LOOM_SIGN_IN_MODE
    await expect(readSignInConfig(env)).rejects.toThrow()
    env.LOOM_SIGN_IN_DOMAINS = 'company.com'
    expect(await readSignInConfig(env)).toMatchObject({ domains: ['company.com'] })
  })
})
