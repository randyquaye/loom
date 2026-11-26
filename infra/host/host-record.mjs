// Deployment checks the same fixed public resolver as the desktop. No local DNS fallback.
import { createHash, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function managedHost(host) {
  return host.split('.')[0].length <= 63 && /^(?:pilot|o-[a-z0-9]+(?:-[a-z0-9]+)*)\.loombox\.xyz$/.test(host)
}

export function proofDomains(host, domains, mode = 'company') {
  if (mode === 'managed') {
    if (!managedHost(host)) throw new Error('Managed sign-in requires a Loom-operated host')
    return [host]
  }
  if (mode !== 'company') throw new Error('Invalid sign-in mode')
  const values = domains
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (values.length === 0) throw new Error('Company sign-in requires Workspace domains')
  return values
}

export function hostRecord(host, privateKey, googleClientId) {
  if (
    googleClientId !== undefined &&
    (!managedHost(host) || !/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(googleClientId))
  )
    throw new Error('Managed host and Google client ID are required')
  const key = createPublicKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The runner key must be Ed25519')
  const fingerprint = createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('base64')
  return `loom-host=${host}; key=${fingerprint}${googleClientId === undefined ? '' : `; google-client=${googleClientId}`}`
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
  const [host, keyFile, domains = '', mode = 'company', googleClientId] = process.argv.slice(2)
  if (!host || !keyFile)
    throw new Error('Usage: host-record.mjs HOST KEY_FILE DOMAINS [MODE GOOGLE_CLIENT_ID]')
  const names = proofDomains(host, domains, mode)
  if (mode === 'managed' && !googleClientId) throw new Error('Managed sign-in requires a Google client ID')
  const expected = hostRecord(host, readFileSync(keyFile), mode === 'managed' ? googleClientId : undefined)
  console.log(`Add TXT ${names.map((name) => `_loom.${name}`).join(', ')}: ${expected}`)
  for (const domain of names) {
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
            const match = value
              .trim()
              .match(
                /^loom-host=([^;\s]+);\s*key=([A-Za-z0-9+/]{43}=)(?:;\s*google-client=([A-Za-z0-9-]+\.apps\.googleusercontent\.com))?$/
              )
            return (
              match &&
              `loom-host=${match[1].toLowerCase()}; key=${match[2]}${match[3] === undefined ? '' : `; google-client=${match[3]}`}` ===
                expected
            )
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
