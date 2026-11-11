import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { QueuedMessage, SessionRow } from '../../../shared/ipc-contract'
import { EFFORTS, type BackendId, type Effort } from '../../../shared/models'
import { FIX_ERRORS_PROMPT, REVIEW_DIFF_PROMPT } from '../../../shared/prompts/flows'
import { initialChoice, useDefaults } from '../../state/defaults'
import { useFiles } from '../../state/files'
import { useProjects } from '../../state/projects'
import { isTurnRunning, useSessions } from '../../state/sessions'
import { useAttachmentDrop } from '../../hooks/useAttachmentDrop'
import { useUi } from '../../state/ui'
import { useTalk } from '../../audio/talk'
import { useSpeech } from '../../audio/speechController'
import { talkHandoff, utteranceOf } from '../../../shared/stt'
import { useToasts } from '../ui/Toast'
import { WeaveMark } from '../ui/WeaveMark'
import { AttachChips, AttachPicker } from './Attachments'
import { ContextDonut } from './ContextDonut'
import { ModelPicker } from './ModelPicker'
import { HeadphonesIcon, MicIcon, SpeakerIcon } from '../ui/icons'
import { VoiceStage } from './VoiceStage'
import './flow.css'

export function Composer({
  workspaceId,
  sessionId,
  disabled
}: {
  workspaceId: string
  sessionId: string | null
  disabled: boolean
}) {
  if (sessionId === null)
    return <StartComposer key={`new:${workspaceId}`} workspaceId={workspaceId} disabled={disabled} />
  return <SessionComposer key={sessionId} sessionId={sessionId} disabled={disabled} />
}

interface Choice {
  backend: BackendId
  model: string
  effort: Effort
}

type Flow = 'review' | 'fix'

async function flowContext(workspaceId: string, flow: Flow): Promise<string> {
  // Refresh even when Changes has a cache: a flow must use the current worktree.
  await useFiles.getState().loadChanges(workspaceId)
  const changes = useFiles.getState().changesByWorkspace[workspaceId] ?? []
  const diffs = await Promise.all(
    changes.slice(0, 6).map(async ({ path }) => {
      const diff = await window.loom.git.diff(workspaceId, path)
      const lines = diff.split(/\r?\n/)
      const excerpt = lines.slice(0, 150).join('\n')
      const truncated = lines.length > 150 ? '\n[Diff truncated after 150 lines.]' : ''
      return `--- ${path}\n${excerpt || 'No textual diff available.'}${truncated}`
    })
  )
  let context = `\n\nCurrent uncommitted changes:\n${diffs.join('\n\n') || 'No uncommitted changes.'}`
  if (flow === 'fix') {
    const lintable = changes
      .filter(({ path, status }) => status !== 'deleted' && /\.(ts|tsx|js|json|py)$/i.test(path))
      .slice(0, 4)
    const diagnostics = await Promise.all(
      lintable.map(async ({ path }) => {
        // Opening through useFiles would activate the pinned viewer and leave the chat.
        const { text } = await window.loom.files.read(workspaceId, path)
        const results = await window.loom.lint.run(workspaceId, path, text)
        return results.map(({ line, message }) => `${path}:${line} ${message.replace(/\s*\r?\n\s*/g, ' ')}`)
      })
    )
    const summary = lintable.length === 0 ? 'No changed lintable files.' : 'No diagnostics reported.'
    context += `\n\nDiagnostics:\n${diagnostics.flat().join('\n') || summary}`
  }
  return context
}

/**
 * Electron wraps errors thrown in main ("Error invoking remote method …: Error: …"), so the
 * ATTACHMENT_REJECTED prefix is matched anywhere in the message, not only at its start.
 */
function sendFailure(err: unknown): string {
  const rejected = /ATTACHMENT_REJECTED:\s*([\s\S]*)$/.exec(String(err))
  return rejected === null ? `Send failed: ${String(err)}` : `Attachment rejected: ${rejected[1] ?? ''}`
}

/** SessionRow.effort is a plain string on the wire; anything unknown reads as medium. */
function asEffort(value: string): Effort {
  return (EFFORTS as readonly string[]).includes(value) ? (value as Effort) : 'medium'
}

/**
 * Composer text that survives remounts (tab switches, the viewer tab, route changes): restored
 * from the ui store on mount and saved on every change. A one-shot draft from a quick prompt
 * replaces it and focuses the field whenever it arrives, mounted or not.
 */
function useComposeText(key: string) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [text, setLocal] = useState(() => useUi.getState().draftBySession[key] ?? '')
  const incoming = useUi((s) => s.draft)

  function setText(next: string) {
    setLocal(next)
    useUi.getState().saveComposeDraft(key, next)
  }

  useEffect(() => {
    if (incoming === null) return
    useUi.getState().setDraft(null)
    setLocal(incoming)
    useUi.getState().saveComposeDraft(key, incoming)
    // Focus once the new value has rendered so the caret lands at its end. Not cancelled on
    // cleanup: clearing the draft re-runs this effect before the frame fires.
    requestAnimationFrame(() => {
      const el = ref.current
      if (el === null) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [incoming, key])

  return { text, setText, ref }
}

/**
 * No session yet: the picker shows the loadout's first entry until the user
 * picks something, and sending creates the session with what it shows. The
 * default is derived, not copied into state, so it tracks Settings edits and
 * late-loading catalogs without a sync effect.
 */
function StartComposer({ workspaceId, disabled }: { workspaceId: string; disabled: boolean }) {
  const create = useSessions((s) => s.create)
  const push = useToasts((s) => s.push)
  const loadout = useDefaults((s) => s.loadout)
  const modelsByBackend = useSessions((s) => s.modelsByBackend)
  const [picked, setPicked] = useState<Choice | null>(null)
  const draftKey = `new:${workspaceId}`
  const { text, setText, ref } = useComposeText(draftKey)
  const [pending, setPending] = useState<Flow | 'message' | null>(null)
  const inFlight = useRef(false)
  const busy = pending !== null
  const attachments = useUi((state) => state.attachmentsBySession[draftKey]) ?? []
  const drop = useAttachmentDrop(draftKey, disabled || busy)

  const choice: Choice = picked ?? initialChoice(loadout, modelsByBackend)
  const { backend, model, effort } = choice

  async function submit(flow?: Flow) {
    if (
      disabled ||
      inFlight.current ||
      model === '' ||
      (flow === undefined && text.trim() === '' && attachments.length === 0)
    )
      return
    inFlight.current = true
    setPending(flow ?? 'message')
    let prompt = text
    let created: string | null = null
    try {
      if (flow !== undefined) {
        const { projects, workspacesByProject } = useProjects.getState()
        const workspace = Object.values(workspacesByProject)
          .flat()
          .find((row) => row.id === workspaceId)
        const project = projects.find((row) => row.id === workspace?.projectId)
        if (project === undefined) throw new Error('Project not available for this workspace.')
        const template =
          flow === 'review'
            ? (project.customPromptCodeReview ?? REVIEW_DIFF_PROMPT)
            : (project.customPromptFixErrors ?? FIX_ERRORS_PROMPT)
        prompt = template + (await flowContext(workspaceId, flow))
      }
      const session = await create(workspaceId, backend, model, effort)
      created = session.id
      // A flow spends its generated prompt; keep any separately typed draft for later.
      if (flow === undefined) useUi.getState().saveComposeDraft(draftKey, '')
      useUi.getState().clearAttachments(draftKey)
      await window.loom.sessions.send(session.id, prompt, attachments)
    } catch (err) {
      if (created === null) {
        push(`Could not start session: ${String(err)}`, 'err')
      } else {
        push(`Send failed: ${String(err)}`, 'err')
        // Hand the prompt to the session composer that replaced this one, so nothing is lost.
        useUi.getState().setDraft(prompt)
        for (const path of attachments) useUi.getState().addAttachment(created, path)
      }
    } finally {
      inFlight.current = false
      setPending(null)
    }
  }

  return (
    <div className="composer composer-start" {...drop.handlers} data-dropping={drop.dragging}>
      <div className="empty-state composer-start-empty">
        <WeaveMark />
        <div className="empty-title">What should we build?</div>
        <div className="quick-chips" role="group" aria-label="Quick actions">
          <button
            type="button"
            className="chip"
            disabled={disabled || busy}
            onClick={() => useUi.getState().setDraft('Summarize repo')}
          >
            Summarize repo
          </button>
          <button
            type="button"
            className="chip"
            disabled={disabled || busy}
            onClick={() => useUi.getState().setDraft('Plan a change')}
          >
            Plan a change
          </button>
          <button
            type="button"
            className="chip"
            disabled={disabled || busy || model === ''}
            aria-label="Review diff"
            aria-busy={pending === 'review'}
            onClick={() => void submit('review')}
          >
            {pending === 'review' ? 'Preparing review…' : 'Review diff'}
          </button>
          <button
            type="button"
            className="chip"
            disabled={disabled || busy || model === ''}
            aria-label="Fix errors"
            aria-busy={pending === 'fix'}
            onClick={() => void submit('fix')}
          >
            {pending === 'fix' ? 'Collecting diagnostics…' : 'Fix errors'}
          </button>
        </div>
        <div className="composer-start-hint" role="status">
          {pending === 'review'
            ? 'Collecting current changes…'
            : pending === 'fix'
              ? 'Collecting current changes and diagnostics…'
              : 'Ask an agent below. File paths in replies open in the viewer.'}
        </div>
      </div>
      <div className="composer composer-start-input">
        {drop.dragging && (
          <div className="composer-drop-hint" role="status">
            Drop text files or images
          </div>
        )}
        <AttachChips sessionId={draftKey} disabled={disabled || busy} />
        <fieldset className="composer-box" disabled={disabled || busy} aria-label="Message composer">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask anything…"
            aria-label="Message"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div className="composer-footer">
            <ModelPicker
              backend={backend}
              model={model}
              effort={effort}
              onPick={(b, m, e) => {
                if (!disabled && !busy) setPicked({ backend: b, model: m, effort: e })
              }}
            />
            <span className="grow" />
            <AttachPicker workspaceId={workspaceId} sessionId={draftKey} disabled={disabled || busy} />
            <button
              className="send-btn"
              onClick={() => void submit()}
              disabled={disabled || busy || model === '' || (text.trim() === '' && attachments.length === 0)}
              title="Send"
              aria-label="Send"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
              </svg>
            </button>
          </div>
        </fieldset>
      </div>
    </div>
  )
}

function SessionComposer({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const drop = useAttachmentDrop(sessionId, disabled)
  const attached = useUi((state) => state.attachmentsBySession[sessionId]) ?? []
  const cancel = useSessions((s) => s.cancel)
  const fork = useSessions((s) => s.fork)
  const session = useSessions(
    (s) =>
      Object.values(s.sessionsByWorkspace)
        .flat()
        .find((row) => row.id === sessionId) ?? null
  )
  // Derived from the event stream, so a turn started elsewhere (e.g. the first turn sent by the
  // start composer just before this one mounted) still shows Cancel.
  const running = useSessions((s) => isTurnRunning(s.eventsBySession[sessionId] ?? []))
  const push = useToasts((s) => s.push)
  const { text, setText, ref } = useComposeText(sessionId)
  const talk = useTalk(sessionId, (utterance, handsFree) => {
    const ui = useUi.getState()
    // Voice mode hides the draft, so speech must not be appended to it and vanish; hands-free
    // queues behind a running turn so background talk can never cut the agent off.
    if (ui.voiceMode) {
      void sendSpoken(utterance, running && !handsFree)
      return
    }
    const draft = ui.draftBySession[sessionId] ?? text
    const attachmentCount = (ui.attachmentsBySession[sessionId] ?? []).length
    const handoff = talkHandoff(draft, attachmentCount, running)
    if (handoff.kind === 'append') {
      // Preserve unrelated draft material: the utterance joins it for review, no auto-send.
      setText(draft.trim() === '' ? utterance : `${draft}\n${utterance}`)
      return
    }
    setText(utterance)
    if (handoff.interrupt) void submitNow()
    else void submit()
  })
  const voiceEnabled = useUi((s) => s.voiceEnabled)
  const setVoiceEnabled = useUi((s) => s.setVoiceEnabled)
  const voiceMode = useUi((s) => s.voiceMode)
  const setVoiceMode = useUi((s) => s.setVoiceMode)
  const { setHandsFree, press, release } = talk
  // Voice mode hides the text box until you type; it returns to hidden once empty and blurred.
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    if (voiceMode) return
    setHandsFree(false)
    setTyping(false)
  }, [voiceMode, setHandsFree])

  // ⌘⇧V toggles voice mode; only a session composer has a conversation to talk to.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyV' || !e.metaKey || !e.shiftKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      const ui = useUi.getState()
      ui.setVoiceMode(!ui.voiceMode)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Voice-mode keys outside text fields: hold Space to talk; any other printable key reveals
  // the text box focused in time for that keystroke to land in it.
  useEffect(() => {
    if (!voiceMode) return
    const inField = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    const down = (e: KeyboardEvent) => {
      if (inField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat) void press()
      } else if (e.key.length === 1) {
        flushSync(() => setTyping(true))
        ref.current?.focus()
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || inField(e.target)) return
      e.preventDefault()
      void release()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [voiceMode, press, release, ref])
  useSpeech(sessionId)
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [removing, setRemoving] = useState(false)
  const queueRequest = useRef({ revision: 0, removing: false, active: false })
  const busy = running

  useEffect(() => {
    const request = queueRequest.current
    request.active = true
    let active = true
    let pushed = false
    const unsubscribe = window.loom.onSessionQueue((update) => {
      if (update.sessionId !== sessionId) return
      pushed = true
      request.revision++
      setQueue(update.items)
    })
    void window.loom.sessions.queue(sessionId).then(
      (items) => {
        // A live push wins over an older snapshot that was already in flight.
        if (active && !pushed) setQueue(items)
      },
      (err: unknown) => {
        if (active && !pushed) push(`Could not load queue: ${String(err)}`, 'err')
      }
    )
    return () => {
      active = false
      request.active = false
      unsubscribe()
    }
  }, [sessionId, push])

  async function updateQueued(index: number, promote = false) {
    const request = queueRequest.current
    if (request.removing) return
    request.removing = true
    setRemoving(true)
    const revision = request.revision
    try {
      const items = promote
        ? await window.loom.sessions.steerQueued(sessionId, queue[index]!.id)
        : await window.loom.sessions.dequeue(sessionId, index)
      if (request.active && request.revision === revision) setQueue(items)
    } catch (err) {
      if (request.active)
        push(`Could not ${promote ? 'steer' : 'remove'} queued message: ${String(err)}`, 'err')
    } finally {
      request.removing = false
      if (request.active) setRemoving(false)
    }
  }

  /** Model/effort are fixed per session: a different pick forks into a new, immediately active tab. */
  function forkTo(source: SessionRow, backend: BackendId, model: string, effort: Effort) {
    if (disabled) return
    const label = useSessions.getState().modelsByBackend[backend]?.find((m) => m.id === model)?.label ?? model
    fork({ workspaceId: source.workspaceId, backend, model, effort, sourceSessionId: source.id })
      .then(() => push(`Forked to ${label}`))
      .catch((err: unknown) => push(`Fork failed: ${String(err)}`, 'err'))
  }

  /**
   * Spends the draft text and attachments synchronously, so rapid clicks cannot submit them
   * twice. A send may stay pending for the whole turn, so chips are not held until it resolves
   * (a follow-up queued meanwhile would re-send them); a failure restores both instead.
   */
  const canSteer = useSessions(
    (s) =>
      s.modelsByBackend[session?.backend ?? '']?.find((model) => model.id === session?.model)
        ?.supportsSteering === true
  )

  async function deliver(mode: 'queue' | 'steer' | 'interrupt') {
    const prompt = useUi.getState().draftBySession[sessionId] ?? text
    const attachments = useUi.getState().attachmentsBySession[sessionId] ?? []
    if (disabled || (prompt.trim() === '' && attachments.length === 0)) return
    setText('')
    useUi.getState().clearAttachments(sessionId)
    try {
      // The store's send/sendNow take no attachments; call the bridge directly.
      if (mode === 'steer') await window.loom.sessions.steer(sessionId, prompt, attachments)
      else if (mode === 'interrupt') await window.loom.sessions.sendNow(sessionId, prompt, attachments)
      else await window.loom.sessions.send(sessionId, prompt, attachments)
    } catch (err) {
      push(sendFailure(err), 'err')
      const currentDraft = useUi.getState().draftBySession[sessionId] ?? ''
      setText(currentDraft === '' ? prompt : `${prompt}\n${currentDraft}`)
      const ui = useUi.getState()
      const added = ui.attachmentsBySession[sessionId] ?? []
      ui.clearAttachments(sessionId)
      for (const path of [...attachments, ...added]) ui.addAttachment(sessionId, path)
    }
  }

  function submit() {
    return deliver('queue')
  }

  async function sendSpoken(utterance: string, interrupt: boolean) {
    if (disabled) return
    try {
      if (interrupt) await window.loom.sessions.sendNow(sessionId, utterance, [])
      else await window.loom.sessions.send(sessionId, utterance, [])
    } catch (err) {
      push(sendFailure(err), 'err')
    }
  }

  /** Interrupts the turn in flight and sends the draft ahead of anything queued. */
  function submitNow() {
    return deliver('interrupt')
  }

  return (
    <div
      className="composer composer-session"
      data-voice={voiceMode}
      data-typing={typing}
      {...drop.handlers}
      data-dropping={drop.dragging}
    >
      {drop.dragging && (
        <div className="composer-drop-hint" role="status">
          Drop text files or images
        </div>
      )}
      {voiceMode && <VoiceStage sessionId={sessionId} talk={talk} />}
      <div className="composer-queue-slot">
        <ol
          className="composer-queue"
          aria-label="Queued messages"
          aria-live="polite"
          aria-relevant="additions removals"
        >
          {queue.map((message, index) => (
            <li className="composer-queue-chip" key={message.id}>
              <span className="composer-queue-index">{index + 1}</span>
              <span className="composer-queue-text" title={message.text}>
                {message.text.replace(/\s+/g, ' ')}
              </span>
              <span className="composer-queue-tag">queued</span>
              {busy && canSteer && (
                <button
                  type="button"
                  className="btn btn-ghost composer-queue-steer"
                  aria-label={`Steer queued message ${index + 1} now`}
                  disabled={disabled || removing}
                  onClick={() => void updateQueued(index, true)}
                >
                  Steer now
                </button>
              )}
              <button
                type="button"
                className="composer-queue-remove"
                aria-label={`Remove queued message ${index + 1}`}
                disabled={disabled || removing}
                onClick={() => void updateQueued(index)}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      </div>
      <AttachChips sessionId={sessionId} disabled={disabled} />
      {(talk.phase !== 'idle' || talk.stt.error !== null) && (
        <div className="stt-strip" role="status">
          {talk.stt.error !== null ? (
            <span className="stt-error">{talk.stt.error}</span>
          ) : (
            <span className="stt-live">{utteranceOf(talk.stt)}</span>
          )}
          {talk.phase === 'capturing' && (
            <button type="button" className="btn btn-ghost" onClick={talk.cancel}>
              Cancel
            </button>
          )}
        </div>
      )}
      <fieldset className="composer-box" disabled={disabled} aria-label="Message composer">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask anything…"
          aria-label="Message"
          onBlur={() => {
            if (text.trim() === '') setTyping(false)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return
            e.preventDefault()
            if ((e.metaKey || e.ctrlKey) && running && canSteer) void deliver('steer')
            else void submit()
          }}
        />
        <div className="composer-footer">
          {session !== null && (
            <>
              <ModelPicker
                mode="fork"
                backend={session.backend}
                model={session.model}
                effort={asEffort(session.effort)}
                onPick={(backend, model, effort) => forkTo(session, backend, model, effort)}
              />
              <ContextDonut session={session} />
            </>
          )}
          <span className="grow" />
          {busy && canSteer && (
            <button
              type="button"
              className="btn btn-ghost composer-tool"
              disabled={disabled || (text.trim() === '' && attached.length === 0)}
              title="Guide the running turn without stopping it (⌘Enter)"
              onClick={() => void deliver('steer')}
            >
              Steer now
            </button>
          )}
          <button
            className="btn btn-ghost composer-tool composer-sendnow"
            data-visible={busy}
            disabled={disabled || !busy || (text.trim() === '' && attached.length === 0)}
            title="Interrupt the running turn and send this message now"
            onClick={() => void submitNow()}
          >
            Interrupt &amp; send
          </button>
          <AttachPicker
            workspaceId={session?.workspaceId ?? ''}
            sessionId={sessionId}
            disabled={disabled || session === null}
          />
          <button
            type="button"
            className="composer-icon voice-btn"
            data-on={voiceEnabled}
            aria-pressed={voiceEnabled}
            title={voiceEnabled ? 'Voice replies on' : 'Voice replies off'}
            aria-label={voiceEnabled ? 'Voice replies on' : 'Voice replies off'}
            onClick={() => setVoiceEnabled(!voiceEnabled)}
          >
            <SpeakerIcon />
          </button>
          {voiceMode && (
            <button
              type="button"
              className="btn btn-ghost composer-tool hands-free-btn"
              aria-pressed={talk.handsFree}
              title={talk.handsFree ? 'Stop listening' : 'Listen without holding the mic'}
              onClick={() => setHandsFree(!talk.handsFree)}
            >
              Hands-free
            </button>
          )}
          <button
            type="button"
            className="composer-icon voice-mode-btn"
            aria-pressed={voiceMode}
            title={voiceMode ? 'Leave voice mode' : 'Voice mode'}
            aria-label={voiceMode ? 'Leave voice mode' : 'Voice mode'}
            onClick={() => setVoiceMode(!voiceMode)}
          >
            <HeadphonesIcon />
          </button>
          <button
            type="button"
            className="composer-icon talk-btn"
            data-phase={talk.phase}
            disabled={disabled}
            title={talk.phase === 'idle' ? 'Hold to talk' : 'Release to finish'}
            aria-label={talk.phase === 'idle' ? 'Hold to talk' : 'Release to finish'}
            onPointerDown={() => void talk.press()}
            onPointerUp={() => void talk.release()}
            onPointerLeave={() => {
              if (talk.phase === 'capturing') void talk.release()
            }}
          >
            <MicIcon />
          </button>
          <button
            className="send-btn"
            onClick={() =>
              busy
                ? void cancel(sessionId).catch((err: unknown) => push(`Cancel failed: ${String(err)}`, 'err'))
                : void submit()
            }
            disabled={disabled || (!busy && text.trim() === '' && attached.length === 0)}
            title={busy ? 'Stop turn' : 'Send'}
            aria-label={busy ? 'Stop turn' : 'Send'}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              {busy ? (
                <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
              ) : (
                <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
              )}
            </svg>
          </button>
        </div>
      </fieldset>
    </div>
  )
}
