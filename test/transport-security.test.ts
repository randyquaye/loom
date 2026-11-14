import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type Agent, type Server } from 'node:https'
import { createConnection, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRunnerTransport } from '../src/main/cloud/transport'
import { connectRunner } from '../src/main/cloud/client'
import { createPortForwards } from '../src/main/cloud/port-forwards'
import { RUNNER_PATH, RUNNER_PROTOCOL } from '../src/shared/runner-contract'
import { transportProofPayload, type TransportProof } from '../src/shared/org'

interface Leaf {
  key: string
  cert: string
}
interface Seen {
  path: string
  authorization: string | undefined
  body: string
}
let root: string
let ca: string
let first: Leaf
let second: Leaf
const org = generateKeyPairSync('ed25519')
const publicKey = org.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const orgFingerprint = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64')
const closers: Array<() => Promise<unknown> | void> = []

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'loom-transport-security-'))
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: root, stdio: 'ignore' })
  openssl(
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Loom transport test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt'
  )
  await writeFile(
    path.join(root, 'leaf.ext'),
    'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n'
  )
  const leaf = async (name: string, serial: string): Promise<Leaf> => {
    openssl(
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-subj',
      '/CN=localhost',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`
    )
    openssl(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-set_serial',
      serial,
      '-days',
      '2',
      '-extfile',
      'leaf.ext',
      '-out',
      `${name}.crt`
    )
    return {
      key: await readFile(path.join(root, `${name}.key`), 'utf8'),
      cert: await readFile(path.join(root, `${name}.crt`), 'utf8')
    }
  }
  ca = await readFile(path.join(root, 'ca.crt'), 'utf8')
  first = await leaf('first', '1')
  second = await leaf('second', '2')
})
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})
afterAll(async () => rm(root, { recursive: true, force: true }))

function manifest(leaf: Leaf, now = Date.now()): TransportProof {
  const tlsFingerprint = createHash('sha256')
    .update(new X509Certificate(leaf.cert).publicKey.export({ format: 'der', type: 'spki' }))
    .digest('base64')
  const value = {
    host: 'localhost',
    public_key: publicKey,
    tls_fingerprint: tlsFingerprint,
    issued_at: now - 1000,
    expires_at: now + 60_000
  }
  return {
    ...value,
    signature: sign(null, Buffer.from(transportProofPayload(value)), org.privateKey).toString('base64')
  }
}

/** Public manifest retrieval is deliberately unpinned and contains no credential. */
function publicRequest(url: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { ca, agent: false }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.once('end', () =>
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 200 }))
      )
      incoming.once('error', reject)
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

async function fixture(actual: Leaf = first, approved: Leaf = first) {
  const seen: Seen[] = []
  let proof: TransportProof | null = manifest(approved)
  let listed = true
  const ticketKeys = randomBytes(48)
  const server: Server = createServer({ ...actual, ticketKeys }, async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Buffer))
    seen.push({
      path: incoming.url ?? '',
      authorization: incoming.headers.authorization,
      body: Buffer.concat(chunks).toString()
    })
    if (incoming.url === '/auth/transport') {
      outgoing
        .writeHead(proof === null ? 404 : 200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(proof))
    } else {
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
    }
  })
  server.on('tlsClientError', () => {})
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (incoming, socket, head) => {
    seen.push({ path: incoming.url ?? '', authorization: incoming.headers.authorization, body: '' })
    sockets.handleUpgrade(incoming, socket, head, (ws) => {
      if (incoming.url?.startsWith('/v1/forward/')) ws.on('message', (data) => ws.send(data))
      else
        ws.on('message', (raw) => {
          const frame = JSON.parse(String(raw)) as { type: string; id?: number }
          if (frame.type === 'hello') ws.send(JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL }))
          else ws.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: 'pong' }))
        })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, 'localhost', resolve)
  })
  closers.push(async () => {
    for (const ws of sockets.clients) ws.terminate()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const base = `https://localhost:${(server.address() as AddressInfo).port}`
  const lookups = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === `${base}/auth/transport`) return publicRequest(url)
    expect(new URL(url).origin).toBe('https://cloudflare-dns.com')
    expect(new URL(url).searchParams.get('name')).toBe('_loom.company.test')
    return Response.json({
      Status: 0,
      Answer: listed
        ? [
            {
              name: '_loom.company.test.',
              type: 16,
              data: JSON.stringify(`loom-host=localhost; key=${orgFingerprint}`)
            }
          ]
        : []
    })
  })
  const transport = createRunnerTransport({
    base,
    trust: async () => ({ version: 3, domain: 'company.test' }),
    ca,
    fetch: lookups
  })
  closers.push(() => transport.close())
  return {
    base,
    transport,
    seen,
    lookups,
    proof: (value: TransportProof | null) => {
      proof = value
    },
    listed: (value: boolean) => {
      listed = value
    },
    rotate: (leaf: Leaf) => {
      server.setSecureContext(leaf)
      server.setTicketKeys(ticketKeys)
    }
  }
}

async function socketWith(agent: Agent | undefined, url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, {
    agent,
    headers: { Authorization: 'Bearer private-access-token' },
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2'
  })
  socket.on('error', () => {})
  const opened = once(socket, 'open').then(() => socket)
  closers.push(() => socket.terminate())
  return opened
}

describe('actual runner transport security', () => {
  const credentials: Array<[string, string, Record<string, string>]> = [
    [
      'code exchange',
      '/auth/token',
      { grant_type: 'authorization_code', code: 'public-code', code_verifier: 'private-pkce-verifier' }
    ],
    ['refresh', '/auth/token', { grant_type: 'refresh_token', refresh_token: 'private-refresh-token' }],
    ['revoke', '/auth/revoke', { token: 'private-revoke-token' }]
  ]
  it.each(credentials)(
    'sends no %s credential to a same-host TLS terminator relaying the legitimate manifest',
    async (_kind, route, fields) => {
      const fx = await fixture(second, first)
      await expect(fx.transport.post(route, fields)).rejects.toThrow()
      expect(fx.seen).toEqual([{ path: '/auth/transport', authorization: undefined, body: '' }])
      expect(JSON.stringify(fx.seen)).not.toMatch(/private-|code_verifier|refresh_token/)
    }
  )

  it('sends credentials only through a matching CA-valid TLS leaf', async () => {
    const fx = await fixture()
    const response = await fx.transport.post('/auth/token', {
      grant_type: 'refresh_token',
      refresh_token: 'private-refresh-token'
    })
    expect(response.ok).toBe(true)
    expect(fx.seen.at(-1)).toMatchObject({
      path: '/auth/token',
      body: 'grant_type=refresh_token&refresh_token=private-refresh-token'
    })
  })

  it('protects the main WebSocket handshake against a same-host manifest relay', async () => {
    const fx = await fixture(second, first)
    const state = vi.fn()
    const client = connectRunner({
      url: fx.base.replace('https:', 'wss:'),
      transport: fx.transport,
      token: async () => 'private-access-token',
      onState: state,
      onPush: () => {}
    })
    closers.push(() => client.close())
    await expect.poll(() => state.mock.calls.some(([value]) => value.state === 'unreachable')).toBe(true)
    expect(
      fx.seen.every((request) => request.path === '/auth/transport' && request.authorization === undefined)
    ).toBe(true)
    expect(fx.seen.length).toBeGreaterThan(0)
  })

  it('serves the legitimate main WebSocket over its verified transport', async () => {
    const fx = await fixture()
    const state = vi.fn()
    const client = connectRunner({
      url: fx.base.replace('https:', 'wss:'),
      transport: fx.transport,
      token: async () => 'private-access-token',
      onState: state,
      onPush: () => {}
    })
    closers.push(() => client.close())
    await expect.poll(() => state.mock.calls.some(([value]) => value.state === 'connected')).toBe(true)
    expect(await client.call('app:ping', undefined)).toBe('pong')
    expect(fx.seen.at(-1)).toMatchObject({ path: RUNNER_PATH, authorization: 'Bearer private-access-token' })
  })

  it.each([false, true])('verifies the actual forwarded WebSocket leaf (attacker=%s)', async (attacker) => {
    const fx = await fixture(attacker ? second : first, first)
    const forwards = createPortForwards({
      url: fx.base.replace('https:', 'wss:'),
      transport: fx.transport,
      token: async () => 'private-forward-token',
      isConnected: () => true,
      check: async () => {}
    })
    closers.push(() => forwards.close())
    const port = await forwards.forward('workspace', 3000)
    const local = createConnection(port.localPort, '127.0.0.1')
    local.on('error', () => {})
    closers.push(() => {
      local.destroy()
    })
    const closed = once(local, 'close')
    if (attacker) {
      local.write('private-forward-body')
      await closed
      expect(
        fx.seen.every((request) => request.path === '/auth/transport' && request.authorization === undefined)
      ).toBe(true)
    } else {
      const data = once(local, 'data')
      local.write('private-forward-body')
      expect(String((await data)[0])).toBe('private-forward-body')
      expect(fx.seen.at(-1)).toMatchObject({ authorization: 'Bearer private-forward-token' })
    }
  })

  it('rechecks warm connections and accepts a newly signed leaf rotation without Google sign-in', async () => {
    const fx = await fixture()
    await fx.transport.post('/auth/token', { refresh_token: 'first-private-token' })
    fx.rotate(second)
    await expect(fx.transport.post('/auth/token', { refresh_token: 'must-not-leak' })).rejects.toThrow()
    expect(fx.seen.filter((request) => request.path === '/auth/token')).toHaveLength(1)
    fx.proof(manifest(second))
    expect((await fx.transport.post('/auth/token', { refresh_token: 'rotated-private-token' })).ok).toBe(true)
    expect(fx.seen.filter((request) => request.path === '/auth/token')).toHaveLength(2)
    expect(fx.lookups.mock.calls.filter(([url]) => String(url).includes('cloudflare-dns.com'))).toHaveLength(
      3
    )
  })

  it.each(['missing', 'expired', 'domain'] as const)(
    'fails closed for a %s proof after a successful connection',
    async (failure) => {
      const fx = await fixture()
      await fx.transport.post('/auth/token', { refresh_token: 'first-private-token' })
      if (failure === 'missing') fx.proof(null)
      else if (failure === 'expired') fx.proof(manifest(first, Date.now() - 120_000))
      else fx.listed(false)
      await expect(fx.transport.post('/auth/token', { refresh_token: 'must-not-leak' })).rejects.toThrow()
      expect(fx.seen.filter((request) => request.path === '/auth/token')).toHaveLength(1)
    }
  )

  it('cannot resume a cached TLS session to bypass a changed leaf key', async () => {
    const fx = await fixture()
    const agent = await fx.transport.websocketAgent()
    closers.push(() => agent?.destroy())
    const firstSocket = await socketWith(agent, fx.base.replace('https:', 'wss:') + RUNNER_PATH)
    const closed = once(firstSocket, 'close')
    firstSocket.close()
    await closed
    fx.rotate(second)
    await expect(socketWith(agent, fx.base.replace('https:', 'wss:') + RUNNER_PATH)).rejects.toThrow()
    expect(fx.seen.filter((request) => request.path === RUNNER_PATH)).toHaveLength(1)
  })
})
