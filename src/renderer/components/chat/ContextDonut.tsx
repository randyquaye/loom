import type { SessionRow } from '../../../shared/ipc-contract'
import type { AgentEvent } from '../../../shared/events'
import { contextWindowFor } from '../../../shared/models'
import { useSessions } from '../../state/sessions'
import './flow.css'

type UsageEvent = Extract<AgentEvent, { type: 'usage' }>

function isUsage(event: AgentEvent): event is UsageEvent {
  return event.type === 'usage'
}

/**
 * Per-turn context tokens for the meter. codex reports cumulative thread
 * totals in its usage events, so its per-turn context is the delta between
 * consecutive events; with a single event there is nothing to delta against
 * and the donut stays hidden rather than showing a meaningless total.
 */
function contextTokens(events: AgentEvent[] | undefined, backend: SessionRow['backend']): number | null {
  if (events === undefined) return null
  const usages = events.filter(isUsage)
  const last = usages[usages.length - 1]
  if (last === undefined) return null
  if (backend !== 'codex') return last.inputTokens
  const prev = usages[usages.length - 2]
  if (prev === undefined || last.inputTokens < prev.inputTokens) return null
  return last.inputTokens - prev.inputTokens
}

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Estimated context-window fill for the session's model, as a 16px ring beside the model picker.
 * The slot is always reserved so the footer never shifts; the ring itself only renders once there
 * is a usable usage figure.
 */
export function ContextDonut({ session }: { session: SessionRow }) {
  const inputTokens = useSessions((s) => contextTokens(s.eventsBySession[session.id], session.backend))
  const percent =
    inputTokens === null || inputTokens === 0
      ? null
      : Math.round((inputTokens / contextWindowFor(session.model)) * 100)
  const tone = percent === null ? 'ok' : percent > 85 ? 'danger' : percent >= 60 ? 'warn' : 'ok'
  const filled = percent === null ? 0 : Math.min(100, Math.max(0, percent)) / 100

  return (
    <span
      className="context-donut-slot"
      title={percent === null ? undefined : `≈${percent}% of the model context window (estimated)`}
    >
      {percent !== null && (
        <svg
          className="context-donut"
          data-tone={tone}
          viewBox="0 0 16 16"
          width="16"
          height="16"
          aria-hidden="true"
        >
          <circle className="context-donut-track" cx="8" cy="8" r={RADIUS} />
          <circle
            className="context-donut-arc"
            cx="8"
            cy="8"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - filled)}
          />
        </svg>
      )}
    </span>
  )
}
