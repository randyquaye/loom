// Deployment checks the same fixed public resolver as the desktop. No local DNS fallback.
import { createHash, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function hostRecord(host, privateKey) {
  const key = createPublicKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The runner key must be Ed25519')
  const fingerprint = createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('base64')
  return `loom-host=${host}; key=${fingerprint}`
}

export function txtValues(data) {
  if (typeof data !== 'string') return []
  const chunks = [...data.matchAll(/"(?:[^"\\]|\\.)*"/g)]
  if (chunks.length === 0 || data.replace(/"(?:[^"\\]|\\.)*"/g, '').trim() !== '') return []
  try {
    return [chunks.map((chunk) => JSON.parse(chunk[0])).join('')]
  } catch {
    return []
  }
}

async function main() {
  const [host, keyFile, domains] = process.argv.slice(2)
  if (!host || !keyFile || !domains) throw new Error('Usage: host-record.mjs HOST KEY_FILE DOMAINS')
  const expected = hostRecord(host, readFileSync(keyFile))
  console.log(`On every allowed Workspace domain, add TXT _loom.DOMAIN: ${expected}`)
  for (const domain of domains.split(',').map((value) => value.trim().toLowerCase())) {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) throw new Error('Invalid Workspace domain')
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(`_loom.${domain}`)}&type=TXT`,
      {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error'
      }
    )
    if (!response.ok) throw new Error(`DNS lookup failed for ${domain}`)
    const answer = await response.json()
    if (
      answer.Status !== 0 ||
      !Array.isArray(answer.Answer) ||
      !answer.Answer.some(
        (entry) =>
          entry.type === 16 &&
          entry.name?.toLowerCase().replace(/\.$/, '') === `_loom.${domain}` &&
          txtValues(entry.data).some((value) => {
            const match = value.trim().match(/^loom-host=([^;\s]+);\s*key=([A-Za-z0-9+/]{43}=)$/)
            return match && `loom-host=${match[1].toLowerCase()}; key=${match[2]}` === expected
          })
      )
    )
      throw new Error(
        `The domain record at _loom.${domain} does not list this host and key. Add it, then deploy again.`
      )
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
