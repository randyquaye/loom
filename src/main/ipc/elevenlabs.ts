import type { ElevenLabsStatus, SingleUseTokenResult } from '../../shared/ipc-contract'
import { handle, secretPresence, type IpcDeps } from './handle'

export const ELEVENLABS_KEY_HINT =
  'Add an ElevenLabs API key in Settings → Integrations to enable spoken replies.'

/** Single-use token scopes Loom mints in main; the long-lived key never crosses the bridge. */
const TOKEN_SCOPES = {
  stt: 'realtime_scribe',
  tts: 'tts_websocket'
} as const

type TokenScope = (typeof TOKEN_SCOPES)[keyof typeof TOKEN_SCOPES]

const TOKEN_WAIT_MS = 10_000

/**
 * Mints a single-use ElevenLabs websocket token in main so the long-lived key never crosses
 * the bridge; the renderer connects to ElevenLabs directly with the token (no gateway hop).
 */
async function mintToken(deps: IpcDeps, scope: TokenScope): Promise<SingleUseTokenResult> {
  let key: string | null
  try {
    key = await deps.secrets.get('elevenlabs')
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
  if (key === null) return { kind: 'needs-key' }
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/single-use-token/${scope}`, {
      method: 'POST',
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(TOKEN_WAIT_MS)
    })
    if (!res.ok) return { kind: 'error', message: `ElevenLabs token request failed: ${res.status}` }
    const body = (await res.json()) as { token?: unknown } | string
    const token = typeof body === 'string' ? body : body.token
    if (typeof token !== 'string' || token === '') {
      return { kind: 'error', message: 'ElevenLabs returned no token' }
    }
    return { kind: 'ok', token }
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/** Probe for the aggregate status call; never throws, mirroring linearStatus. */
export async function elevenlabsStatus(deps: IpcDeps): Promise<ElevenLabsStatus> {
  try {
    const key = await deps.secrets.get('elevenlabs')
    return key === null ? { state: 'needs-key', hint: ELEVENLABS_KEY_HINT } : { state: 'ready' }
  } catch (err) {
    return { state: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

export function registerElevenLabsIpc(deps: IpcDeps): void {
  handle('elevenlabs:hasKey', () => secretPresence(deps.secrets, 'elevenlabs'))
  handle('elevenlabs:setKey', ({ value }) => deps.secrets.set('elevenlabs', value))
  handle('elevenlabs:deleteKey', () => deps.secrets.delete('elevenlabs'))
  handle('elevenlabs:sttToken', () => mintToken(deps, TOKEN_SCOPES.stt))
  handle('elevenlabs:ttsToken', () => mintToken(deps, TOKEN_SCOPES.tts))
}
