import type { ElevenLabsStatus, SecretPresence, SttTokenResult } from '../../shared/ipc-contract'
import { handle, maskSecret, type IpcDeps } from './index'

export const ELEVENLABS_KEY_HINT =
  'Add an ElevenLabs API key in Settings → Integrations to enable spoken replies.'

/** Probe for the aggregate status call; never throws, mirroring linearStatus. */
export async function elevenlabsStatus(deps: IpcDeps): Promise<ElevenLabsStatus> {
  try {
    const key = await deps.secrets.get('elevenlabs')
    return key === null ? { state: 'needs-key', hint: ELEVENLABS_KEY_HINT } : { state: 'ready' }
  } catch (err) {
    return { state: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Credential path only (audio spec increment 1): the key lives in the existing encrypted
 * store under a namespaced id and crosses IPC masked, exactly like Linear's. No provider
 * calls, no audio pipeline, no new backend.
 */
const STT_TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe'
const TOKEN_WAIT_MS = 10_000

/**
 * Mints the single-use realtime-STT token in main so the long-lived key never crosses the
 * bridge; the renderer connects to ElevenLabs directly with the token (no gateway hop).
 */
async function mintSttToken(deps: IpcDeps): Promise<SttTokenResult> {
  let key: string | null
  try {
    key = await deps.secrets.get('elevenlabs')
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
  if (key === null) return { kind: 'needs-key' }
  try {
    const res = await fetch(STT_TOKEN_URL, {
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

export function registerElevenLabsIpc(deps: IpcDeps): void {
  handle('elevenlabs:hasKey', async (): Promise<SecretPresence> => {
    const value = await deps.secrets.get('elevenlabs')
    return value === null ? { present: false, masked: null } : { present: true, masked: maskSecret(value) }
  })
  handle('elevenlabs:setKey', ({ value }) => deps.secrets.set('elevenlabs', value))
  handle('elevenlabs:deleteKey', () => deps.secrets.delete('elevenlabs'))
  handle('elevenlabs:sttToken', () => mintSttToken(deps))
}
