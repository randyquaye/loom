import type { ElevenLabsStatus, SecretPresence } from '../../shared/ipc-contract'
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
export function registerElevenLabsIpc(deps: IpcDeps): void {
  handle('elevenlabs:hasKey', async (): Promise<SecretPresence> => {
    const value = await deps.secrets.get('elevenlabs')
    return value === null ? { present: false, masked: null } : { present: true, masked: maskSecret(value) }
  })
  handle('elevenlabs:setKey', ({ value }) => deps.secrets.set('elevenlabs', value))
  handle('elevenlabs:deleteKey', () => deps.secrets.delete('elevenlabs'))
}
