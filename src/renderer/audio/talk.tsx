import { useCallback, useEffect, useRef, useState } from 'react'
import { useToasts } from '../components/ui/Toast'
import { STT_INITIAL, type SttState } from '../../shared/stt'
import { SttClient, startMic } from './stt'

export type TalkPhase = 'idle' | 'capturing' | 'finalizing'

export function MicGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M8 2a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 0 1-5 0v-3A2.5 2.5 0 0 1 8 2Z" />
      <path d="M4.5 7.5a3.5 3.5 0 0 0 7 0M8 11v2.5" />
    </svg>
  )
}

/**
 * Press-to-talk capture for one session: mints the single-use token through the bridge,
 * opens the direct Scribe socket, and keeps the live transcript separate from the
 * conversation. Release finalizes the utterance; cancel, session changes and unmount
 * invalidate everything, so late provider callbacks can never reach another conversation.
 */
export function useTalk(sessionId: string) {
  const push = useToasts((s) => s.push)
  const [phase, setPhase] = useState<TalkPhase>('idle')
  const [stt, setStt] = useState<SttState>(STT_INITIAL)
  const [finalized, setFinalized] = useState<string | null>(null)
  const client = useRef<SttClient | null>(null)
  const stopMic = useRef<(() => void) | null>(null)

  const teardown = useCallback(() => {
    stopMic.current?.()
    stopMic.current = null
    client.current?.cancel()
    client.current = null
  }, [])

  useEffect(() => teardown, [sessionId, teardown])

  const press = useCallback(async () => {
    if (client.current !== null) return
    setFinalized(null)
    setStt(STT_INITIAL)
    const token = await window.loom.elevenlabs.sttToken().catch((err: unknown) => {
      push(`Speech setup failed: ${String(err)}`, 'err')
      return null
    })
    if (token === null) return
    if (token.kind === 'needs-key') {
      push('ElevenLabs API key required — add it in Settings → Integrations', 'err')
      return
    }
    if (token.kind === 'error') {
      push(`Speech setup failed: ${token.message}`, 'err')
      return
    }
    const sttClient = new SttClient(setStt)
    client.current = sttClient
    sttClient.start(token.token)
    setPhase('capturing')
    try {
      stopMic.current = await startMic((chunk) => sttClient.sendChunk(chunk))
    } catch (err) {
      push(`Microphone unavailable: ${String(err)}`, 'err')
      teardown()
      setPhase('idle')
    }
  }, [push, teardown])

  const release = useCallback(async () => {
    const sttClient = client.current
    if (sttClient === null) return
    setPhase('finalizing')
    stopMic.current?.()
    stopMic.current = null
    const utterance = await sttClient.release()
    client.current = null
    setPhase('idle')
    if (utterance === null) {
      // Empty or cancelled capture: return to ready without touching the conversation.
      setStt(STT_INITIAL)
      return
    }
    setFinalized(utterance)
  }, [])

  const cancel = useCallback(() => {
    teardown()
    setPhase('idle')
    setStt(STT_INITIAL)
    setFinalized(null)
  }, [teardown])

  return { phase, stt, finalized, press, release, cancel }
}
