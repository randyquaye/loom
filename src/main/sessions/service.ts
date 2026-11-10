import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { renderEventForSearch, type AgentEvent, type QuestionAnswer } from '../../shared/events'
import { questionAnswerText, validateQuestionAnswers, visibleQuestionAnswers } from '../../shared/questions'
import {
  type SessionCreateInput,
  type SessionEventPush,
  type SessionRow,
  type SessionTitlePush
} from '../../shared/ipc-contract'
import { MAX_SESSIONS_PER_WORKSPACE } from '../../shared/limits'
import type { BackendId, Effort, PromptImage } from '../../shared/models'
import { cleanTitle, excerptTitle } from './title'
import { envNames } from '../env/vars'
import { AttachmentError, formatAttachment, readPromptAttachment, resolveAttachment } from './attachments'
import { getBackend } from '../agents/registry'
import type { RunningSession } from '../agents/types'
import { AUTOLINK_SYSTEM_PROMPT } from '../agents/prompts/autolink'
import { SKILL_FACTS } from '../agents/skill'
import {
  attachmentFileName,
  MANAGED_AGENTS_MARKER,
  refreshWorkspaceAgentsDoc,
  writeAttachment,
  writeLoomContext
} from '../context/materialize'
import { CheckpointBusyError, CheckpointRootError, saveCheckpoint } from '../git/checkpoint'
import { setAgentsExclude } from '../git/exclude'
import { GitError } from '../git/run'
import { getWorkspaceOrThrow, renameWorkspaceIfAuto } from '../db/repos/workspaces'
import { readInstructionOverlay } from '../instructions/files'
import {
  announceWorkspace,
  waitForWorkspaceSettled,
  WorkspaceNotReadyError,
  workspaceEnv
} from '../workspace/bootstrap'
import { eventsToMarkdown } from '../export/markdown'

type Sink = (push: SessionEventPush) => void

let sink: Sink | null = null

/** Wired by main once the window exists; session events push through it. */
export function setSessionSink(fn: Sink): void {
  sink = fn
}

const live = new Map<string, RunningSession>()
interface PreparedTurn {
  text: string
  images: PromptImage[]
  promptText?: string
  displayText?: string
}

export class SessionLimitError extends Error {}

interface SessionBackendRow {
  workspace_id: string
  backend: string
  model: string
  effort: string
  provider_session_id: string | null
}

const SESSION_COLUMNS = `id, workspace_id AS workspaceId, backend, model, effort, title,
  created_at AS createdAt, closed_at AS closedAt, forked_from AS forkedFrom,
  provider_session_id AS providerSessionId`

/** The cap counts open tabs: closed rows stay reopenable and must not block new ones. */
function assertSessionCapacity(db: Database.Database, workspaceId: string): void {
  const open = db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ? AND closed_at IS NULL')
    .get(workspaceId) as { n: number }
  if (open.n >= MAX_SESSIONS_PER_WORKSPACE) {
    throw new SessionLimitError(`workspace is limited to ${MAX_SESSIONS_PER_WORKSPACE} sessions`)
  }
}

export function listSessions(db: Database.Database, workspaceId: string): SessionRow[] {
  const rows = db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace_id = ? AND closed_at IS NULL ORDER BY created_at`
    )
    .all(workspaceId) as SessionRow[]
  return rows
}

/** Recently closed sessions, newest first, for the tab bar's reopen menu. */
export function closedSessions(db: Database.Database, workspaceId: string): SessionRow[] {
  return db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE workspace_id = ? AND closed_at IS NOT NULL
       ORDER BY closed_at DESC, rowid DESC LIMIT 10`
    )
    .all(workspaceId) as SessionRow[]
}

/** Clears the close stamp so a closed tab returns; the cap counts open rows only. */
export function reopenSession(db: Database.Database, sessionId: string): SessionRow {
  const row = db
    .prepare('SELECT workspace_id AS workspaceId FROM sessions WHERE id = ? AND closed_at IS NOT NULL')
    .get(sessionId) as { workspaceId: string } | undefined
  if (row === undefined) throw new Error(`no closed session ${sessionId}`)
  assertSessionCapacity(db, row.workspaceId)
  db.prepare('UPDATE sessions SET closed_at = NULL WHERE id = ?').run(sessionId)
  return db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId) as SessionRow
}

export function createSession(db: Database.Database, input: SessionCreateInput): SessionRow {
  assertSessionCapacity(db, input.workspaceId)
  const row: SessionRow = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    backend: input.backend,
    model: input.model,
    effort: input.effort,
    title: input.title,
    createdAt: Date.now(),
    closedAt: null,
    forkedFrom: null,
    providerSessionId: null
  }
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, backend, model, effort, title, created_at, closed_at, forked_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.workspaceId,
    row.backend,
    row.model,
    row.effort,
    row.title,
    row.createdAt,
    row.closedAt,
    row.forkedFrom
  )
  return row
}

export function sessionEvents(db: Database.Database, sessionId: string): AgentEvent[] {
  const rows = db
    .prepare('SELECT payload, ts FROM events WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as Array<{ payload: string; ts: number }>
  return rows.map((row) => {
    const event = JSON.parse(row.payload) as AgentEvent
    // Rows written before turns carried real stamps get them from the row timestamp.
    if (event.type === 'turn.done' && event.at === undefined) return { ...event, at: row.ts }
    if (event.type === 'turn.started' && !event.at) return { ...event, at: row.ts }
    return event
  })
}

function appendEvent(db: Database.Database, sessionId: string, event: AgentEvent): void {
  let stamped = event
  if (
    (event.type === 'turn.done' && event.at === undefined) ||
    (event.type === 'turn.started' && !event.at)
  ) {
    stamped = { ...event, at: Date.now() }
  }
  const seqRow = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?')
    .get(sessionId) as { next: number }
  db.prepare('INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)').run(
    sessionId,
    seqRow.next,
    Date.now(),
    stamped.type,
    JSON.stringify(stamped)
  )
  const text = renderEventForSearch(stamped)
  if (text !== '') {
    db.prepare('INSERT INTO events_rendered (session_id, text) VALUES (?, ?)').run(sessionId, text)
  }
  sink?.({ sessionId, event: stamped })
}

/** A non-retryable failure, recorded in the transcript where the user will see it. */
function appendError(
  db: Database.Database,
  sessionId: string,
  code: string,
  error: unknown,
  turnId?: string
): void {
  appendEvent(db, sessionId, {
    type: 'error',
    ...(turnId === undefined ? {} : { turnId }),
    code,
    message: String(error),
    retryable: false
  })
}

/** A turn nobody awaits (queue drain, send-now, fork hand-off): failures land in the transcript. */
function sendDetached(db: Database.Database, sessionId: string, input: PreparedTurn, code: string): void {
  void sendPreparedTurn(db, sessionId, input).catch((error: unknown) =>
    appendError(db, sessionId, code, error)
  )
}

async function pump(db: Database.Database, sessionId: string, session: RunningSession): Promise<void> {
  let settled = false
  let failed = false
  try {
    for await (const event of session.events) {
      appendEvent(db, sessionId, event)
      // Errors do not end a turn: codex reports retryable failures mid-turn and keeps going,
      // and every backend closes a failed turn with turn.done. Settling early let the next
      // message skip the queue into a turn still in flight.
      if (event.type === 'error' && !event.retryable) failed = true
      else if (event.type === 'turn.done') {
        // A failed turn keeps the queue for the user to retry or drop explicitly.
        if (live.get(sessionId) === session)
          settleTurn(db, sessionId, event.stopReason !== 'error' && !failed)
        settled = true
        failed = false
      }
    }
    // One-shot backends end their stream at turn end without a trailing event. Skipped
    // when the loop already settled: that settle may have started the next turn, whose
    // busy flag this pump must not clear.
    if (live.get(sessionId) === session) {
      live.delete(sessionId)
      if (!settled) settleTurn(db, sessionId, !failed)
    }
  } catch (error) {
    appendError(db, sessionId, 'stream', error)
    if (live.get(sessionId) === session) {
      live.delete(sessionId)
      settleTurn(db, sessionId, false)
    }
  } finally {
    if (live.get(sessionId) === session) live.delete(sessionId)
  }
}

/** Turns in flight and messages waiting for them, per session (process-local). */
const busyTurns = new Map<string, string>()
const queues = new Map<string, PreparedTurn[]>()
const preparing = new Map<string, { work: Promise<PreparedTurn>; controller: AbortController }>()
/** A message the user forced over a running turn; sent the moment that turn ends. */
const immediate = new Map<string, PreparedTurn[]>()

/**
 * Clears the busy flag at turn end and picks what runs next: a forced send-now message
 * goes first, otherwise the queue drains. A failed turn keeps its queue for the user to
 * retry or drop, but still honours an explicit send-now.
 */
function settleTurn(db: Database.Database, sessionId: string, drain: boolean): void {
  busyTurns.delete(sessionId)
  const pending = immediate.get(sessionId)
  const now = pending?.shift()
  if (now !== undefined) {
    if (pending?.length === 0) immediate.delete(sessionId)
    sendDetached(db, sessionId, now, 'send.now')
    return
  }
  if (drain) drainQueue(db, sessionId)
}

/**
 * Interrupts the turn in flight and puts `text` ahead of the queue. The old stream is still
 * dying when this returns, so the message waits in the immediate slot and settleTurn sends
 * it the moment the turn ends — never as a second concurrent provider stream.
 */
export async function sendNow(
  db: Database.Database,
  sessionId: string,
  text: string,
  attachments: readonly string[] = [],
  deniedRoots: readonly string[] = []
): Promise<void> {
  if (!busyTurns.has(sessionId)) return sendTurn(db, sessionId, text, attachments, deniedRoots)
  const target = busyTurns.get(sessionId)
  const work = prepareInput(db, sessionId, text, attachments, deniedRoots)
  const input = work instanceof Promise ? await work : work
  if (busyTurns.get(sessionId) !== target) return sendPreparedTurn(db, sessionId, input)
  const pending = immediate.get(sessionId) ?? []
  pending.push(input)
  immediate.set(sessionId, pending)
  if (pending.length === 1) await cancelTurn(db, sessionId)
}

type QueueSink = (push: { sessionId: string; items: string[] }) => void

let queueSink: QueueSink | null = null

/** Wired by main once the window exists; queue changes push through it. */
export function setQueueSink(fn: QueueSink): void {
  queueSink = fn
}

function pushQueue(sessionId: string): void {
  queueSink?.({ sessionId, items: sessionQueue(sessionId) })
}

type TitleSink = (push: SessionTitlePush) => void

let titleSink: TitleSink | null = null

/** Wired by main once the window exists; renames push through it. */
export function setTitleSink(fn: TitleSink): void {
  titleSink = fn
}

function setTitle(db: Database.Database, sessionId: string, title: string): void {
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionId)
  titleSink?.({ sessionId, title })
}

/**
 * Names a conversation from its first prompt: an excerpt immediately so the list is never
 * blank, replaced by the model's own name whenever it arrives. There is deliberately no
 * caller-side timeout: each backend caps its own naming call (CLI one-shots at 20s, the loop
 * completion via abort), and a cold spawn that lost an 8s race used to strand the excerpt
 * forever. Any failure keeps the excerpt. The workspace's display name follows the first
 * model title while it is still auto-derived.
 */
async function renameFromPrompt(
  db: Database.Database,
  sessionId: string,
  workspaceId: string,
  backend: BackendId,
  model: string,
  prompt: string
): Promise<void> {
  setTitle(db, sessionId, excerptTitle(prompt))
  const backendImpl = getBackend(backend)
  let named: string | null = null
  try {
    const raw = backendImpl?.title === undefined ? null : await backendImpl.title(prompt, model)
    named = cleanTitle(raw)
  } catch {
    named = null
  }
  if (named === null) return
  setTitle(db, sessionId, named)
  if (renameWorkspaceIfAuto(db, workspaceId, named)) announceWorkspace(db, workspaceId)
}

/**
 * Inlines attachments above the user's message so every backend sees identical input and
 * the transcript shows exactly what was sent. Relative paths are jailed to the worktree by
 * contain(); absolute ones arrive from the native dialog and are vetted by the attachments
 * module (deny-list, caps, binary refusal).
 */
async function composeWithAttachments(
  db: Database.Database,
  sessionId: string,
  text: string,
  attachments: readonly string[],
  deniedRoots: readonly string[]
): Promise<PreparedTurn> {
  if (attachments.length === 0) return { text, images: [] }
  const ws = db
    .prepare(
      'SELECT w.worktree_path, s.backend, s.model FROM workspaces w JOIN sessions s ON s.workspace_id = w.id WHERE s.id = ? AND s.closed_at IS NULL'
    )
    .get(sessionId) as { worktree_path: string; backend: BackendId; model: string } | undefined
  if (ws === undefined) throw new Error(`unknown session ${sessionId}`)
  const blocks: string[] = []
  const images: PromptImage[] = []
  for (const raw of attachments) {
    const resolved = await resolveAttachment(ws.worktree_path, raw, deniedRoots)
    const attachment = await readPromptAttachment(resolved.abs, resolved.label)
    if (attachment.kind === 'image') {
      images.push(attachment.image)
      blocks.push(`<attached image: ${resolved.label}>`)
    } else blocks.push(formatAttachment(resolved.label, attachment.content))
  }
  if (images.length > 0) {
    const models = await getBackend(ws.backend)?.listModels()
    if (models?.find((model) => model.id === ws.model)?.supportsImages !== true) {
      throw new AttachmentError(
        `${ws.model} does not support image attachments; choose an image-capable model`
      )
    }
  }
  return { text: `${blocks.join('\n\n')}\n\n${text}`, images, promptText: text }
}

/** Serializes only preparation, leaving active turns free to receive guidance. */
function prepareInput(
  db: Database.Database,
  sessionId: string,
  text: string,
  attachments: readonly string[],
  deniedRoots: readonly string[]
): PreparedTurn | Promise<PreparedTurn> {
  const previous = preparing.get(sessionId)
  if (attachments.length === 0 && previous === undefined) return { text, images: [] }
  const controller = previous?.controller ?? new AbortController()
  const compose = () => {
    controller.signal.throwIfAborted()
    return composeWithAttachments(db, sessionId, text, attachments, deniedRoots)
  }
  const work = (previous === undefined ? compose() : previous.work.catch(() => undefined).then(compose)).then(
    (input) => {
      controller.signal.throwIfAborted()
      return input
    }
  )
  preparing.set(sessionId, { work, controller })
  const clear = () => {
    if (preparing.get(sessionId)?.work === work) preparing.delete(sessionId)
  }
  void work.then(clear, clear)
  return work
}

export function sessionQueue(sessionId: string): string[] {
  return (queues.get(sessionId) ?? []).map((input) => input.displayText ?? input.text)
}

export function dequeue(sessionId: string, index: number): string[] {
  const queue = queues.get(sessionId)
  if (queue === undefined) return []
  queue.splice(index, 1)
  if (queue.length === 0) queues.delete(sessionId)
  pushQueue(sessionId)
  return sessionQueue(sessionId)
}

function drainQueue(db: Database.Database, sessionId: string): void {
  const queue = queues.get(sessionId)
  const next = queue?.shift()
  if (queue !== undefined && queue.length === 0) queues.delete(sessionId)
  if (next === undefined) return
  pushQueue(sessionId)
  sendDetached(db, sessionId, next, 'queue.drain')
}

export function sendTurn(
  db: Database.Database,
  sessionId: string,
  text: string,
  attachments: readonly string[] = [],
  deniedRoots: readonly string[] = []
): Promise<void> {
  try {
    const work = prepareInput(db, sessionId, text, attachments, deniedRoots)
    return work instanceof Promise
      ? work.then((input) => sendPreparedTurn(db, sessionId, input))
      : sendPreparedTurn(db, sessionId, work)
  } catch (error) {
    return Promise.reject(error)
  }
}

async function sendPreparedTurn(
  db: Database.Database,
  sessionId: string,
  input: PreparedTurn
): Promise<void> {
  const row = db
    .prepare(
      'SELECT workspace_id, backend, model, effort, provider_session_id FROM sessions WHERE id = ? AND closed_at IS NULL'
    )
    .get(sessionId) as SessionBackendRow | undefined
  if (row === undefined) throw new Error(`unknown session ${sessionId}`)

  // A prompt that reaches a workspace mid-setup (or after a failed one) would spawn the CLI
  // in a directory that is not a checkout yet — codex answers that with its trusted-directory
  // refusal. Settle first; an already-ready workspace adds no await, so the queueing path
  // behind a running turn keeps its no-tick promise.
  const gate = getWorkspaceOrThrow(db, row.workspace_id)
  if (gate.state !== 'ready') {
    const settled = gate.state === 'error' ? gate : await waitForWorkspaceSettled(db, gate.id)
    if (settled.state !== 'ready') throw new WorkspaceNotReadyError(gate.id, settled.state)
  }

  // Inlined before the busy check so a message queued behind a running turn keeps its files.
  // No await on the attachment-free path: an extra tick here lets a settling turn clear the
  // busy flag before the next send arrives, which would silently un-queue it.
  const body = input.text

  // A turn already in flight: queue the message instead of spawning a second
  // process against the same provider session.
  if (busyTurns.has(sessionId)) {
    const queue = queues.get(sessionId) ?? []
    queue.push(input)
    queues.set(sessionId, queue)
    pushQueue(sessionId)
    return
  }
  const turnId = randomUUID()
  busyTurns.set(sessionId, turnId)
  try {
    const isFirstPrompt =
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = ?')
          .get(sessionId, 'user.text') as { n: number }
      ).n === 0

    appendEvent(db, sessionId, { type: 'user.text', turnId, text: input.displayText ?? body })
    // Titles and checkpoints describe what the user asked, not the inlined files.
    if (isFirstPrompt) {
      void renameFromPrompt(
        db,
        sessionId,
        row.workspace_id,
        row.backend as BackendId,
        row.model,
        input.promptText ?? input.displayText ?? body
      )
    }

    const wsRow = db
      .prepare(
        `SELECT w.name, w.branch, w.worktree_path, p.repo_path, p.id AS project_id
         FROM workspaces w JOIN projects p ON p.id = w.project_id WHERE w.id = ?`
      )
      .get(row.workspace_id) as
      | { name: string; branch: string; worktree_path: string; repo_path: string; project_id: string }
      | undefined
    if (wsRow !== undefined) {
      await writeLoomContext(wsRow.worktree_path, {
        workspaceName: wsRow.name,
        branch: wsRow.branch,
        repoPath: wsRow.repo_path,
        backend: row.backend,
        model: row.model,
        effort: row.effort,
        at: Date.now(),
        envNames: await envNames(wsRow.project_id)
      }).catch(() => {})
      // codex reads instructions only from a root AGENTS.md; keep a managed companion fresh
      // while the path is free, and keep git blind to it only while Loom owns it.
      void (async () => {
        const doc = await instructionPrompt(db, row.workspace_id, true)
        const owned = await refreshWorkspaceAgentsDoc(wsRow.worktree_path, doc)
        await setAgentsExclude(wsRow.repo_path, owned)
      })().catch(() => {})
      void autoCheckpoint(wsRow.worktree_path, turnId, input.promptText ?? input.displayText ?? body).catch(
        (error: unknown) => appendError(db, sessionId, 'checkpoint.save', error)
      )
    }

    if (busyTurns.get(sessionId) !== turnId) return
    let session = live.get(sessionId)
    if (session === undefined) {
      const backend = getBackend(row.backend as SessionCreateInput['backend'])
      if (backend === undefined) throw new Error(`backend ${row.backend} is not registered`)
      const worktree = db
        .prepare('SELECT worktree_path FROM workspaces WHERE id = ?')
        .get(row.workspace_id) as { worktree_path: string } | undefined
      if (worktree === undefined) throw new Error(`unknown workspace ${row.workspace_id}`)
      session = await backend.startSession({
        workspaceId: row.workspace_id,
        worktreePath: worktree.worktree_path,
        model: row.model,
        effort: row.effort as Effort,
        systemPromptAppend: await instructionPrompt(
          db,
          row.workspace_id,
          row.backend === 'gemini' || row.backend === 'qwen'
        ),
        resumeId: row.provider_session_id ?? undefined,
        env: await workspaceEnv(db, row.workspace_id),
        pluginDir: loomSkillDir ?? undefined
      })
      if (busyTurns.get(sessionId) !== turnId) {
        await session.close()
        return
      }
      live.set(sessionId, session)
      void pump(db, sessionId, session)
    }
    if (input.images.length === 0) await session.send(body)
    else await session.send(body, input.images)
    const providerId = session.providerSessionId?.()
    if (providerId !== undefined) {
      db.prepare('UPDATE sessions SET provider_session_id = ? WHERE id = ?').run(providerId, sessionId)
    }
  } catch (error) {
    // Only pump settles a claimed turn; a throw before it runs (an unknown model after a
    // catalog change, a failed spawn) would otherwise leave the session busy forever, with
    // every later message queued and never sent. The failure is recorded right after the
    // message it failed, so it is not rethrown: callers would report it a second time.
    appendError(db, sessionId, 'send', error, turnId)
    appendEvent(db, sessionId, { type: 'turn.done', turnId, stopReason: 'error' })
    if (busyTurns.get(sessionId) === turnId) settleTurn(db, sessionId, false)
  }
}

/** Per-turn undo point; busy, mis-rooted or non-git worktrees skip silently. */
async function autoCheckpoint(worktreePath: string, turnId: string, text: string): Promise<void> {
  try {
    await saveCheckpoint(worktreePath, `turn ${turnId}: ${text.slice(0, 60)}`)
  } catch (error) {
    if (
      error instanceof CheckpointBusyError ||
      error instanceof CheckpointRootError ||
      error instanceof GitError
    ) {
      return
    }
    throw error
  }
}

let loomSkillDir: string | null = null
let loomDataRoot: string | null = null

/** Wired at startup so instruction overlays can be read without threading the path everywhere. */
export function setLoomDataRoot(dir: string): void {
  loomDataRoot = dir
}

/** Wired at boot once the bundled skill plugin is materialized under the data root. */
export function setLoomSkillDir(dir: string): void {
  loomSkillDir = dir
}

/**
 * Loom's instruction text for a workspace. With inlineRepoFacts the bundled skill facts and
 * the repository's own CLAUDE.md/AGENTS.md are included too: the loop backends have no
 * instruction-file discovery or skill plugin, and codex reads only the managed AGENTS.md.
 */
async function instructionPrompt(
  db: Database.Database,
  workspaceId: string,
  inlineRepoFacts: boolean
): Promise<string> {
  const row = db
    .prepare(
      `SELECT w.worktree_path, p.id AS project_id, p.custom_prompt_general AS general
       FROM workspaces w JOIN projects p ON p.id = w.project_id WHERE w.id = ?`
    )
    .get(workspaceId) as { worktree_path: string; project_id: string; general: string | null } | undefined
  const parts = [AUTOLINK_SYSTEM_PROMPT]
  if (inlineRepoFacts) parts.push(SKILL_FACTS, ...(await repoInstructionFiles(row?.worktree_path)))
  if (row !== undefined) {
    parts.push(...(await instructionOverlayParts(row.project_id)))
    if ((row.general ?? '').trim() !== '') parts.push(row.general as string)
    const names = await envNames(row.project_id)
    if (names.length > 0) parts.push(envNamesLine(names))
  }
  return parts.join('\n\n')
}

const REPO_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const
const REPO_INSTRUCTION_CAP = 16_000

async function repoInstructionFiles(worktreePath: string | undefined): Promise<string[]> {
  if (worktreePath === undefined) return []
  const out: string[] = []
  for (const name of REPO_INSTRUCTION_FILES) {
    const text = await readFile(path.join(worktreePath, name), 'utf8').catch(() => '')
    // Loom's own managed companion is not a repository instruction; the loop backends
    // already carry its contents through the system prompt.
    if (text.trim() === '' || text.startsWith(MANAGED_AGENTS_MARKER)) continue
    out.push(`# Repository instructions (${name})\n\n${text.slice(0, REPO_INSTRUCTION_CAP)}`)
  }
  return out
}

async function instructionOverlayParts(projectId: string): Promise<string[]> {
  if (loomDataRoot === null) return []
  const overlay = await readInstructionOverlay(loomDataRoot, projectId)
  return overlay.map((entry) =>
    entry.scope === 'instance'
      ? `# Instance instructions\n\n${entry.text}`
      : `# Project instructions\n\n${entry.text}`
  )
}

function envNamesLine(names: string[]): string {
  return (
    `Environment variables available in your shell and process environment: ${names.join(', ')}. ` +
    'Their values are secret: reference them as $NAME and never echo, print, log or commit them.'
  )
}

export async function cancelTurn(db: Database.Database, sessionId: string): Promise<void> {
  const session = live.get(sessionId)
  if (session !== undefined) {
    await session.cancel()
    return
  }
  const turnId = busyTurns.get(sessionId)
  if (turnId !== undefined) {
    appendEvent(db, sessionId, { type: 'turn.done', turnId, stopReason: 'cancelled' })
    settleTurn(db, sessionId, true)
  }
}

export async function steerTurn(
  db: Database.Database,
  sessionId: string,
  text: string,
  attachments: readonly string[] = [],
  deniedRoots: readonly string[] = []
): Promise<void> {
  const session = live.get(sessionId)
  if (!busyTurns.has(sessionId) || session?.steer === undefined)
    throw new Error('There is no steerable turn running')
  const target = busyTurns.get(sessionId)
  const work = prepareInput(db, sessionId, text, attachments, deniedRoots)
  const input = work instanceof Promise ? await work : work
  if (busyTurns.get(sessionId) !== target || live.get(sessionId) !== session)
    throw new Error('The turn ended before guidance was delivered')
  if (input.images.length === 0) await session.steer(input.text)
  else await session.steer(input.text, input.images)
}

/** Replies stay outside turn scheduling and transcript storage, including secret answers. */
export async function answerQuestion(
  db: Database.Database,
  sessionId: string,
  answer: QuestionAnswer
): Promise<void> {
  const history = sessionEvents(db, sessionId)
  const requested = history.findLast(
    (event) => event.type === 'question.requested' && event.requestId === answer.requestId
  )
  if (history.some((event) => event.type === 'question.resolved' && event.requestId === answer.requestId))
    throw new Error('Question is already closed')
  if (requested?.type === 'question.requested' && !requested.blocking && !busyTurns.has(sessionId)) {
    const answers = validateQuestionAnswers(requested, answer)
    const visible = visibleQuestionAnswers(requested, answers)
    const displayText = questionAnswerText(requested, visible)
    sendDetached(
      db,
      sessionId,
      { text: questionAnswerText(requested, answers), images: [], displayText, promptText: displayText },
      'question.followup'
    )
    appendEvent(db, sessionId, {
      type: 'question.answered',
      turnId: requested.turnId,
      requestId: requested.requestId,
      answers: visible
    })
    appendEvent(db, sessionId, {
      type: 'question.resolved',
      turnId: requested.turnId,
      requestId: requested.requestId
    })
    return
  }
  const session = live.get(sessionId)
  if (session?.answerQuestion === undefined) throw new Error('This session cannot answer questions')
  await session.answerQuestion(answer)
}

export function closeSession(sessionId: string): void {
  preparing.get(sessionId)?.controller.abort()
  preparing.delete(sessionId)
  const session = live.get(sessionId)
  if (session) {
    void session.close()
    live.delete(sessionId)
  }
  busyTurns.delete(sessionId)
  queues.delete(sessionId)
  immediate.delete(sessionId)
}

export function closeAllSessions(): void {
  for (const sessionId of new Set([...live.keys(), ...busyTurns.keys(), ...preparing.keys()]))
    closeSession(sessionId)
}

/** Marks the row closed and tears down any live backend session for it. */
export function closeSessionRow(db: Database.Database, sessionId: string): void {
  db.prepare('UPDATE sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(
    Date.now(),
    sessionId
  )
  closeSession(sessionId)
}

export interface ForkInput {
  workspaceId: string
  backend: SessionCreateInput['backend']
  model: string
  effort: Effort
  sourceSessionId: string
}

/** Forks by seeding a brand-new session with the source transcript as its first user turn. */
const FORK_SEED_MAX_EVENTS = 200

export async function forkSession(db: Database.Database, input: ForkInput): Promise<SessionRow> {
  const source = db
    .prepare('SELECT title, backend, model, effort, created_at FROM sessions WHERE id = ?')
    .get(input.sourceSessionId) as
    { title: string; backend: string; model: string; effort: string; created_at: number } | undefined
  if (source === undefined) throw new Error(`unknown session ${input.sourceSessionId}`)

  // Cap the seed so repeatedly-forked sessions cannot grow without bound.
  const sourceEvents = sessionEvents(db, input.sourceSessionId)
  const capped =
    sourceEvents.length > FORK_SEED_MAX_EVENTS ? sourceEvents.slice(-FORK_SEED_MAX_EVENTS) : sourceEvents
  const markdown = eventsToMarkdown(
    {
      title: source.title,
      backend: source.backend,
      model: source.model,
      effort: source.effort,
      createdAt: source.created_at
    },
    capped
  )
  const created = createSession(db, {
    workspaceId: input.workspaceId,
    backend: input.backend,
    model: input.model,
    effort: input.effort,
    title: `fork of ${source.title}`
  })
  db.prepare('UPDATE sessions SET forked_from = ? WHERE id = ?').run(input.sourceSessionId, created.id)
  // The transcript lands as a .context attachment the seeded turn points at,
  // instead of inflating the first user message with the whole markdown body.
  const target = db.prepare('SELECT worktree_path FROM workspaces WHERE id = ?').get(input.workspaceId) as
    { worktree_path: string } | undefined
  if (target === undefined) throw new Error(`unknown workspace ${input.workspaceId}`)
  const transcriptPath = await writeAttachment(
    target.worktree_path,
    attachmentFileName('transcript', source.title, Date.now()),
    markdown
  )
  // Fire-and-forget: the fork returns as soon as the row exists; the seeded turn
  // streams in over the event channel and failures surface as error events.
  sendDetached(
    db,
    created.id,
    {
      text: `Continuing from a previous session. The full transcript is at ${transcriptPath} — read it before answering.`,
      images: []
    },
    'fork.send'
  )
  return { ...created, forkedFrom: input.sourceSessionId }
}
