import { useCallback, useEffect, useRef, useState } from 'react'
import { useToasts } from '../components/ui/Toast'
import { STT_INITIAL, utteranceOf, type SttState, type TalkPhase } from '../../shared/stt'
import { HandsFreeListener } from './handsFree'
import { stopSpeech } from './speechController'
import { SttClient, startMic, type Mic } from './stt'

/**
 * Press-to-talk capture for one session: mints the single-use token through the bridge,
 * opens the direct Scribe socket, and keeps the live transcript separate from the
 * conversation. Release finalizes the utterance and hands it to the composer callback
 * (submit or draft-append per the handoff rule); cancel, session changes and unmount
 * invalidate everything, so late provider callbacks can never reach another conversation.
 */
export type Talk = ReturnType<typeof useTalk>

export function useTalk(sessionId: string, onUtterance: (utterance: string, handsFree: boolean) => void) {
  const push = useToasts((s) => s.push)
  const [phase, setPhase] = useState<TalkPhase>('idle')
  const [stt, setStt] = useState<SttState>(STT_INITIAL)
  const client = useRef<SttClient | null>(null)
  const mic = useRef<Mic | null>(null)
  const listener = useRef<HandsFreeListener | null>(null)
  const [handsFree, setHandsFreeState] = useState(false)
  const utteranceRef = useRef(onUtterance)
  utteranceRef.current = onUtterance

  const teardown = useCallback(() => {
    mic.current?.stop()
    mic.current = null
    client.current?.cancel()
    client.current = null
  }, [])

  useEffect(() => teardown, [sessionId, teardown])

  // Switching sessions or unmounting turns hands-free off: the mic never follows you around.
  useEffect(
    () => () => {
      listener.current?.stop()
      listener.current = null
      setHandsFreeState(false)
    },
    [sessionId]
  )

  const setHandsFree = useCallback(
    (on: boolean) => {
      if (!on && listener.current === null) return
      listener.current?.stop()
      listener.current = null
      setHandsFreeState(on)
      setStt(STT_INITIAL)
      if (!on) return
      teardown()
      setPhase('idle')
      const next = new HandsFreeListener({
        onState: setStt,
        onUtterance: (text) => utteranceRef.current(text, true),
        onStop: (reason) => {
          listener.current = null
          setHandsFreeState(false)
          push(reason, 'err')
        }
      })
      listener.current = next
      void next.start()
    },
    [push, teardown]
  )

  const press = useCallback(async () => {
    // Hands-free is already listening; a press only cuts Loom off mid-sentence.
    if (listener.current !== null) return stopSpeech()
    if (client.current !== null) return
    // Talk during speech: stop playback and invalidate pending speech before listening.
    stopSpeech()
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
      mic.current = await startMic((chunk) => sttClient.sendChunk(chunk))
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
    mic.current?.stop()
    mic.current = null
    const utterance = await sttClient.release()
    client.current = null
    setPhase('idle')
    setStt(STT_INITIAL)
    // Empty or cancelled captures return to ready without touching the conversation.
    if (utterance !== null) utteranceRef.current(utterance, false)
  }, [])

  const cancel = useCallback(() => {
    teardown()
    setPhase('idle')
    setStt(STT_INITIAL)
  }, [teardown])

  /** Polled per animation frame by the voice stage; 0 while the mic is closed. */
  const micLevel = useCallback(() => listener.current?.level() ?? mic.current?.level() ?? 0, [])

  const talkPhase: TalkPhase = handsFree ? (utteranceOf(stt) === '' ? 'armed' : 'capturing') : phase
  return {
    phase: talkPhase,
    stt,
    press,
    release,
    cancel,
    micLevel,
    handsFree,
    setHandsFree
  }
}
