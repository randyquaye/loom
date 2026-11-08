import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { extractSpeech, flushSpeech, SPEECH_CURSOR_START, type SpeechCursor } from '../../shared/speech'
import { useSessions } from '../state/sessions'
import { useUi } from '../state/ui'
import { useDefaults } from '../state/defaults'
import { speechPlayer } from './playback'
import { TtsClient } from './tts'

let activeTts: TtsClient | null = null
let speechGeneration = 0

export interface SpeechStatus {
  /** ElevenLabs audio or the system voice is audible. */
  speaking: boolean
  /** Why speech last fell back to the system voice; cleared when ElevenLabs is reached again. */
  fallback: string | null
}

let status: SpeechStatus = { speaking: false, fallback: null }
const statusListeners = new Set<() => void>()
const systemUtterances = new Set<SpeechSynthesisUtterance>()

function publish(patch: Partial<SpeechStatus>): void {
  const next = { ...status, ...patch }
  if (next.speaking === status.speaking && next.fallback === status.fallback) return
  status = next
  for (const listener of statusListeners) listener()
}

function syncSpeaking(): void {
  publish({ speaking: speechPlayer.speaking || systemUtterances.size > 0 })
}

speechPlayer.subscribe(syncSpeaking)

/** Observer entry for non-React consumers (the hands-free listener mutes the mic on this). */
export function subscribeSpeech(listener: () => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

export function getSpeechStatus(): SpeechStatus {
  return status
}

export function useSpeechStatus(): SpeechStatus {
  return useSyncExternalStore(subscribeSpeech, getSpeechStatus)
}

/** Talk-press and cancellation reach the current synthesis from anywhere in the app. */
export function stopSpeech(): void {
  speechGeneration += 1
  activeTts?.stop()
  activeTts = null
  speechPlayer.stop()
  window.speechSynthesis.cancel()
  systemUtterances.clear()
  syncSpeaking()
}

/**
 * Tracked per utterance, so an end event arriving after stopSpeech cannot clear a newer one.
 * Waits for ElevenLabs audio already received to finish, so the two voices never overlap.
 */
function speakWithSystemVoice(text: string, reason: string): void {
  publish({ fallback: reason })
  const utterance = new SpeechSynthesisUtterance(text)
  const done = () => {
    systemUtterances.delete(utterance)
    syncSpeaking()
  }
  utterance.onend = done
  utterance.onerror = done
  systemUtterances.add(utterance)
  syncSpeaking()
  // stopSpeech clears the set, so a deferred start for a cancelled reply never speaks.
  const start = () => {
    if (systemUtterances.has(utterance)) window.speechSynthesis.speak(utterance)
  }
  if (!speechPlayer.speaking) return start()
  const off = speechPlayer.subscribe(() => {
    if (speechPlayer.speaking) return
    off()
    start()
  })
}

/**
 * Streams eligible foreground prose and list text into speech when the voice toggle is on.
 * History present at enable time never speaks; only newly received text does.
 * Synthesis or token failure falls back to system speech for the sentences ElevenLabs had not
 * voiced yet, so a provider outage degrades to the OS voice instead of silence or repetition.
 */
export function useSpeech(sessionId: string): void {
  const enabled = useUi((s) => s.voiceEnabled)
  const events = useSessions((s) => s.eventsBySession[sessionId])
  const seen = useRef<number | null>(null)
  const cursor = useRef<SpeechCursor>(SPEECH_CURSOR_START)
  const pending = useRef<string[]>([])
  const starting = useRef<number | null>(null)
  const generation = useRef(speechGeneration)
  const streamed = useRef('')
  const finished = useRef(false)
  /** Synthesized characters not yet matched to a whole pending sentence. */
  const voiced = useRef(0)

  const resetTurn = useCallback(() => {
    pending.current = []
    voiced.current = 0
    cursor.current = SPEECH_CURSOR_START
    streamed.current = ''
    finished.current = false
  }, [])

  /** Drops sentences ElevenLabs has already voiced; each was sent with one trailing space. */
  const markVoiced = useCallback((chars: number) => {
    voiced.current += chars
    let next = pending.current[0]
    while (next !== undefined && voiced.current >= next.length + 1) {
      voiced.current -= next.length + 1
      pending.current.shift()
      next = pending.current[0]
    }
  }, [])

  /** Only sentences ElevenLabs never voiced fall back, so nothing is heard twice. */
  const systemFallback = useCallback((reason: string) => {
    const text = pending.current.join(' ')
    pending.current = []
    voiced.current = 0
    if (text !== '') speakWithSystemVoice(text, reason)
  }, [])

  const speak = useCallback(
    (sentences: string[]) => {
      if (sentences.length === 0 || generation.current !== speechGeneration) return
      pending.current.push(...sentences)
      if (activeTts !== null) {
        for (const sentence of sentences) activeTts.send(sentence)
        return
      }
      const gen = speechGeneration
      if (starting.current === gen) return
      starting.current = gen
      void window.loom.elevenlabs
        .ttsToken()
        .then((token) => {
          if (gen !== speechGeneration) return
          if (token.kind !== 'ok') {
            systemFallback(token.kind === 'needs-key' ? 'No ElevenLabs API key' : token.message)
            return
          }
          publish({ fallback: null })
          const client = new TtsClient(
            (message) => {
              if (gen !== speechGeneration) return
              activeTts = null
              systemFallback(message)
            },
            (chars) => {
              if (gen === speechGeneration) markVoiced(chars)
            }
          )
          activeTts = client
          const { voiceId, speechSpeed } = useDefaults.getState()
          client.start(token.token, voiceId, speechSpeed)
          for (const sentence of pending.current) client.send(sentence)
          if (finished.current) client.flush()
        })
        .catch((err: unknown) => {
          if (gen === speechGeneration) systemFallback(String(err))
        })
        .finally(() => {
          if (starting.current === gen) starting.current = null
        })
    },
    [systemFallback, markVoiced]
  )

  useEffect(() => {
    if (!enabled) {
      stopSpeech()
      resetTurn()
      seen.current = events?.length ?? 0
    } else if (seen.current === null) {
      seen.current = events?.length ?? 0
    }
  }, [enabled, events, resetTurn])

  useEffect(() => {
    if (enabled) generation.current = speechGeneration
  }, [enabled])

  useEffect(() => {
    if (!enabled || events === undefined) return
    const start = seen.current ?? events.length
    seen.current = events.length
    for (const event of events.slice(start)) {
      if (event.type === 'turn.started') {
        stopSpeech()
        generation.current = speechGeneration
        resetTurn()
      } else if (event.type === 'text.delta') {
        streamed.current += event.text
        const result = extractSpeech(event.text, cursor.current)
        cursor.current = result.cursor
        speak(result.speech)
      } else if (event.type === 'text.done') {
        // Codex can emit only text.done; streamed backends repeat their complete text here.
        const tail = event.text.startsWith(streamed.current) ? event.text.slice(streamed.current.length) : ''
        const remaining = extractSpeech(tail, cursor.current)
        const result = flushSpeech(remaining.cursor)
        cursor.current = result.cursor
        streamed.current = ''
        speak([...remaining.speech, ...result.speech])
      } else if (event.type === 'turn.done') {
        finished.current = true
        const result = flushSpeech(cursor.current)
        cursor.current = result.cursor
        speak(result.speech)
        activeTts?.flush()
      }
    }
  }, [events, enabled, speak, resetTurn])

  useEffect(() => () => stopSpeech(), [sessionId])
}
