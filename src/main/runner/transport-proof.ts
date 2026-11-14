import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { checkServerIdentity, connect } from 'node:tls'
import { createTransportProof } from '../auth/transport-proof'
import { TRANSPORT_PROOF_TTL_MS, type TransportProof } from '../../shared/org'

/** Observe Caddy itself, never an IP chosen by public DNS. Normal TLS trust remains mandatory. */
export function probeCaddyCertificate(host: string): Promise<X509Certificate> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: '127.0.0.1',
      port: 443,
      servername: host,
      rejectUnauthorized: true,
      checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate)
    })
    const deadline = setTimeout(
      () => socket.destroy(new Error('Local TLS certificate probe timed out')),
      5000
    )
    deadline.unref()
    socket.once('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    socket.once('close', () => {
      clearTimeout(deadline)
      reject(new Error('Local TLS certificate probe closed before verification'))
    })
    socket.once('secureConnect', () => {
      try {
        if (!socket.authorized) throw new Error('Local TLS certificate is not trusted')
        resolve(new X509Certificate(socket.getPeerCertificate().raw))
      } catch (error) {
        reject(error)
      } finally {
        clearTimeout(deadline)
        socket.destroy()
      }
    })
  })
}

/** Only replace the public file after a complete, certificate-bounded signed authorization exists. */
export async function publishTransportProof(
  input: { host: string; keyFile: string; outputFile: string },
  now: () => number = Date.now
): Promise<TransportProof> {
  const certificate = await probeCaddyCertificate(input.host)
  const issuedAt = now()
  const expiresAt = Math.min(issuedAt + TRANSPORT_PROOF_TTL_MS, Date.parse(certificate.validTo))
  const fingerprint = createHash('sha256')
    .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64')
  const proof = createTransportProof(
    await readFile(input.keyFile, 'utf8'),
    input.host,
    fingerprint,
    issuedAt,
    expiresAt
  )
  const temporary = path.join(
    path.dirname(input.outputFile),
    `.${path.basename(input.outputFile)}.${randomUUID()}.tmp`
  )
  try {
    await writeFile(temporary, `${JSON.stringify(proof)}\n`, { mode: 0o644, flag: 'wx' })
    await rename(temporary, input.outputFile)
  } finally {
    await rm(temporary, { force: true })
  }
  return proof
}
