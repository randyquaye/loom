import { createHash, generateKeyPairSync } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const { hostRecord, proofDomains } = await import(
  pathToFileURL(path.resolve('infra/host/host-record.mjs')).href
)
const key = generateKeyPairSync('ed25519')
const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const fingerprint = createHash('sha256')
  .update(key.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64')
const clientId = '123-managed.apps.googleusercontent.com'

describe('operator host authorisation', () => {
  it('publishes the exact managed server key and Google audience at its individual DNS name', () => {
    expect(hostRecord('pilot.loombox.xyz', pem, clientId)).toBe(
      `loom-host=pilot.loombox.xyz; key=${fingerprint}; google-client=${clientId}`
    )
    expect(proofDomains('pilot.loombox.xyz', '', 'managed')).toEqual(['pilot.loombox.xyz'])
  })

  it('preserves company records and their independently selected Workspace domains', () => {
    expect(hostRecord('runner.example.com', pem)).toBe(`loom-host=runner.example.com; key=${fingerprint}`)
    expect(proofDomains('runner.example.com', 'company.com, subsidiary.com', 'company')).toEqual([
      'company.com',
      'subsidiary.com'
    ])
  })

  it('cannot authorise an arbitrary host or incomplete Google client as Loom managed', () => {
    expect(() => hostRecord('runner.example.com', pem, clientId)).toThrow()
    expect(() => hostRecord('pilot.loombox.xyz', pem, 'not-a-google-client')).toThrow()
    expect(() => proofDomains('runner.example.com', '', 'managed')).toThrow()
    expect(() => proofDomains('runner.example.com', '', 'company')).toThrow()
    expect(() => proofDomains('pilot.loombox.xyz', '', 'unknown')).toThrow()
  })
})
