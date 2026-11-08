import { useEffect, useRef, type RefObject } from 'react'
import type { AgentEvent } from '../../../shared/events'
import { utteranceOf } from '../../../shared/stt'
import { deriveVoiceState, unspokenCounts, type VoiceActivity, type VoiceState } from '../../../shared/voice'
import { speechPlayer } from '../../audio/playback'
import { useSpeechStatus } from '../../audio/speechController'
import type { Talk } from '../../audio/talk'
import { useSessions } from '../../state/sessions'
import { useUi } from '../../state/ui'
import { firstLine, toolSummary } from './transcript'
import './voice-stage.css'

const NO_EVENTS: AgentEvent[] = []
/** Speech RMS rarely passes ~0.25; scale so normal speech fills the orb's range. */
const LEVEL_GAIN = 4
const playbackLevel = () => speechPlayer.level()

function activityLine(activity: VoiceActivity): string {
  if (activity.kind === 'subagent') return `Subagent · ${activity.description}`
  const summary = toolSummary({ kind: 'tool', id: '', name: activity.name, args: activity.args })
  return [summary.label, summary.chip ?? summary.target].filter(Boolean).join(' ')
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

function statusLine(state: VoiceState, heard: string, handsFree: boolean): string {
  switch (state.kind) {
    case 'ready':
      return handsFree ? 'Listening — just talk' : 'Hold Space or the orb to talk'
    case 'listening':
      return heard || 'Listening…'
    case 'finalizing':
      return heard || 'One moment…'
    case 'thinking':
      return 'Thinking…'
    case 'working':
      return activityLine(state.activity)
    case 'speaking':
      return 'Speaking'
    case 'error':
      return state.message
  }
}

/** Writes smoothed loudness into --level each frame, bypassing React so 60 updates/s cost no renders. */
function useLevel(ref: RefObject<HTMLElement | null>, read: (() => number) | null): void {
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    el.style.setProperty('--level', '0')
    if (read === null) return
    let smooth = 0
    let frame = 0
    const tick = () => {
      smooth += (Math.min(1, read() * LEVEL_GAIN) - smooth) * 0.3
      el.style.setProperty('--level', smooth.toFixed(3))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [ref, read])
}

/**
 * Audio-first view of the active session: the orb is the hold-to-talk control and follows
 * whichever voice is audible; one status line replaces the transcript; your last message is
 * the only conversation text shown.
 */
export function VoiceStage({ sessionId, talk }: { sessionId: string; talk: Talk }) {
  const events = useSessions((s) => s.eventsBySession[sessionId]) ?? NO_EVENTS
  const speech = useSpeechStatus()
  const state = deriveVoiceState(events, talk.phase, speech.speaking)
  const lastAsked = firstLine(events.findLast((e) => e.type === 'user.text')?.text)
  const note = talk.stt.error ?? (speech.fallback === null ? null : `System voice: ${speech.fallback}`)
  const counts = unspokenCounts(events)
  const eyes =
    counts === null
      ? []
      : [
          counts.codeBlocks > 0 ? plural(counts.codeBlocks, 'code block') : null,
          counts.fileEdits > 0 ? plural(counts.fileEdits, 'file edit') : null
        ].filter((label) => label !== null)
  const orb = useRef<HTMLButtonElement>(null)
  useLevel(orb, state.kind === 'listening' ? talk.micLevel : state.kind === 'speaking' ? playbackLevel : null)

  return (
    <div className="voice-stage" data-state={state.kind} data-hands-free={talk.handsFree}>
      <button
        ref={orb}
        type="button"
        className="voice-orb"
        aria-label={talk.phase === 'idle' ? 'Hold to talk' : 'Release to finish'}
        onPointerDown={() => void talk.press()}
        onPointerUp={() => void talk.release()}
        onPointerLeave={() => {
          if (talk.phase === 'capturing') void talk.release()
        }}
      />
      <p className="voice-status" role="status">
        {statusLine(state, utteranceOf(talk.stt), talk.handsFree)}
      </p>
      {note !== null && <p className="voice-note">{note}</p>}
      {eyes.length > 0 && (
        <div className="voice-eyes" role="group" aria-label="Not spoken">
          {eyes.map((label) => (
            <button
              key={label}
              type="button"
              className="chip"
              title="Not spoken: open the transcript"
              onClick={() => useUi.getState().setVoiceMode(false)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {lastAsked !== '' && (
        <p className="voice-last" title={lastAsked}>
          {lastAsked}
        </p>
      )}
    </div>
  )
}
