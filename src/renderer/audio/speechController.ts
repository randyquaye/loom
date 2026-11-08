import { useCallback, useEffect, useRef } from 'react'
import { extractSpeech, flushSpeech, SPEECH_CURSOR_START, type SpeechCursor } from '../../shared/speech'
import { useSessions } from '../state/sessions'
import { useUi } from '../state/ui'
import { speechPlayer } from './playback'
import { TtsClient } from './tts'

let activeTts: TtsClient | null = null

/** Talk-press and cancellation reach the current synthesis from anywhere in the app. */
export function stopSpeech(): void {
  activeTts?.stop()
  activeTts = null
  speechPlayer.stop()
  window.speechSynthesis.cancel()
}

/**
 * Streams eligible foreground prose of the active session into speech when the voice toggle
 * is on. History present at enable time never speaks (baseline index); only live deltas do.
 * Synthesis or token failure falls back to system speech for the pending sentences, so a
 * provider outage degrades to the OS voice instead of silence.
 */
export function useSpeech(sessionId: string): void {
  const enabled = useUi((s) => s.voiceEnabled)
  const events = useSessions((s) => s.eventsBySession[sessionId])
  const seen = useRef<number | null>(null)
  const cursor = useRef<SpeechCursor>(SPEECH_CURSOR_START)
  const pending = useRef<string[]>([])
  const starting = useRef(false)

  const systemFallback = useCallback(() => {
    const text = pending.current.join(' ')
    pending.current = []
    if (text === '') return
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text))
  }, [])

  const speak = useCallback(
    (sentences: string[]) => {
      if (sentences.length === 0) return
      pending.current.push(...sentences)
      if (activeTts !== null) {
        for (const sentence of sentences) activeTts.send(sentence)
        return
      }
      if (starting.current) return
      starting.current = true
      void window.loom.elevenlabs.ttsToken().then((token) => {
        starting.current = false
        if (token.kind !== 'ok') {
          systemFallback()
          return
        }
        const client = new TtsClient(() => {
          activeTts = null
          speechPlayer.stop()
          systemFallback()
        })
        activeTts = client
        client.start(token.token)
        for (const sentence of pending.current) client.send(sentence)
      })
    },
    [systemFallback]
  )

  useEffect(() => {
    if (!enabled) {
      stopSpeech()
      pending.current = []
      cursor.current = SPEECH_CURSOR_START
      seen.current = events?.length ?? 0
    } else if (seen.current === null) {
      seen.current = events?.length ?? 0
    }
  }, [enabled, events])

  useEffect(() => {
    if (!enabled || events === undefined) return
    const start = seen.current ?? events.length
    seen.current = events.length
    for (const event of events.slice(start)) {
      if (event.type === 'turn.started') {
        stopSpeech()
        pending.current = []
        cursor.current = SPEECH_CURSOR_START
      } else if (event.type === 'text.delta') {
        const result = extractSpeech(event.text, cursor.current)
        cursor.current = result.cursor
        speak(result.speech)
      } else if (event.type === 'text.done' || event.type === 'turn.done') {
        const result = flushSpeech(cursor.current)
        cursor.current = result.cursor
        speak(result.speech)
        activeTts?.flush()
      }
    }
  }, [events, enabled, speak])

  useEffect(() => () => stopSpeech(), [sessionId])
}
