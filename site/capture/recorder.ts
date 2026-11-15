import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { AgentEvent } from '../../src/shared/events'
import type { LoomApi } from '../../src/shared/ipc-contract'
import { assertNothingPersonal, blur, box, demoWindow, launchDemo, openSearchSession, SHOTS, type Box } from './app'
import { encodeVideo, type CameraKey, type Frame, type Loop } from './encode'
import { buildFixture, writeChange } from './fixture'
import type { Step } from './storyboard'

const TYPE_DELAY_MS = 30
/** Longer gaps than this read as stutter in streamed text. */
const MAX_STREAM_GAP_MS = 200
/** Lets the last change finish animating before recording stops. */
const SETTLE_MS = 400
/** Breathing room around everything an action shot frames. */
const MARGIN = 24
/** A hand's pause on the target before pressing, and how long the press lasts. */
const AIM_MS = 140
const PRESS_MS = 80

type Played = { stream: { from: number; to: number }; camera: CameraKey[] }

type Session = { id: string; workspaceId: string; worktree: string }

/**
 * Stands in for the agent: the renderer's real send lands here instead of `sessions:send`,
 * shows the message as main would, and starts nothing.
 */
async function stubAgent(app: ElectronApplication, win: Page): Promise<void> {
  // Activity pushes only apply above the renderer's current revision.
  const revision = await win.evaluate(() =>
    (globalThis as unknown as { loom: LoomApi }).loom.sessions.activity().then((a) => a.revision)
  )
  await app.evaluate(({ ipcMain, BrowserWindow }, revision) => {
    const sent: string[] = []
    Object.assign(globalThis, { loomboxSent: sent, loomboxRevision: revision })
    ipcMain.removeHandler('sessions:send')
    // handle() throws while the real handler is registered, so a failed swap stops the run.
    ipcMain.handle('sessions:send', (_event, input: { sessionId: string; text: string }) => {
      sent.push(input.sessionId)
      const event = { type: 'user.text', turnId: `user-${sent.length}`, text: input.text }
      BrowserWindow.getAllWindows()[0]!.webContents.send('session:event', { sessionId: input.sessionId, event })
    })
  }, revision)
}

/** The workspace a session belongs to, as the renderer knows it. */
function workspaceOf(win: Page, sessionId: string): Promise<{ id: string; worktreePath: string }> {
  return win.evaluate(async (id) => {
    const { loom } = globalThis as unknown as { loom: LoomApi }
    for (const project of await loom.projects.list())
      for (const workspace of await loom.workspaces.list(project.id))
        if ((await loom.sessions.list(workspace.id)).some((session) => session.id === id))
          return { id: workspace.id, worktreePath: workspace.worktreePath }
    throw new Error(`no workspace holds session ${id}`)
  }, sessionId)
}

/**
 * Delivers an event the way main does, with the signals the sidebar shows for work out of
 * view: a running indicator while a turn runs and an unread dot when the answer lands.
 */
function emit(app: ElectronApplication, session: Session, event: AgentEvent): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow }, { session, event }) => {
      const web = BrowserWindow.getAllWindows()[0]!.webContents
      const state = globalThis as unknown as { loomboxRevision: number }
      const revision = ++state.loomboxRevision
      if (event.type === 'turn.started' || event.type === 'turn.done') {
        const bySession = event.type === 'turn.started' ? { [session.id]: session.workspaceId } : {}
        web.send('session:activity', { revision, bySession })
      }
      const unread =
        event.type === 'text.done' ? { workspaceId: session.workspaceId, eventId: revision, seq: revision } : undefined
      web.send('session:event', { sessionId: session.id, workspaceId: session.workspaceId, event, unread })
    },
    { session, event }
  )
}

/** A camera cut: home is chapter 02's own crop; an action shot lists the boxes it must show. */
type Shot = { at: number; boxes?: Box[] }

/** The framing that shows every box, zoomed out only as far as needed and kept in the window. */
function fit(boxes: Box[] | undefined, crop: Box, view: Box): Omit<CameraKey, 'at'> {
  if (boxes === undefined || boxes.length === 0) {
    return { cx: crop.x + crop.width / 2, cy: crop.y + crop.height / 2, zoom: 1 }
  }
  const left = Math.min(...boxes.map((b) => b.x)) - MARGIN
  const top = Math.min(...boxes.map((b) => b.y)) - MARGIN
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + MARGIN
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + MARGIN
  const most = Math.min(view.width / crop.width, view.height / crop.height)
  const zoom = Math.min(Math.max(1, (right - left) / crop.width, (bottom - top) / crop.height), most)
  const inside = (centre: number, size: number, span: number) => Math.min(Math.max(centre, size / 2), span - size / 2)
  return {
    cx: inside((left + right) / 2, crop.width * zoom, view.width),
    cy: inside((top + bottom) / 2, crop.height * zoom, view.height),
    zoom
  }
}

type Point = { x: number; y: number }

/**
 * Draws a pointer that follows the synthetic mouse, with a ring on each press. The screencast
 * never shows the OS cursor, and without one a viewer cannot see where an action starts.
 */
async function showPointer(win: Page, at: Point): Promise<void> {
  await win.evaluate(() => {
    const layer = document.createElement('div')
    layer.setAttribute('aria-hidden', 'true')
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
    // The usual arrow: black with a white edge, tip at (2, 2).
    layer.innerHTML =
      '<svg width="20" height="26" viewBox="0 0 20 26" style="position:absolute;left:-2px;top:-2px">' +
      '<path d="M2 2v19l5-4.5 3.5 7.5 3-1.3-3.5-7.3H17z" fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    document.body.append(layer)
    const arrow = layer.firstElementChild as SVGElement
    addEventListener('mousemove', (e) => (arrow.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`), true)
    addEventListener(
      'mousedown',
      (e) => {
        const ring = document.createElement('div')
        ring.style.cssText = `position:absolute;left:${e.clientX - 14}px;top:${e.clientY - 14}px;width:28px;height:28px;border:1.5px solid rgba(255,255,255,.7);border-radius:50%`
        layer.prepend(ring)
        ring
          .animate([{ transform: 'scale(.4)', opacity: 0.9 }, { transform: 'scale(1.4)', opacity: 0 }], {
            duration: 400,
            easing: 'cubic-bezier(.2,.7,.3,1)'
          })
          .finished.then(() => ring.remove())
      },
      true
    )
  })
  await win.mouse.move(at.x, at.y)
}

/**
 * Moves the mouse like a hand: a minimum-jerk path that takes longer the further it goes.
 * Timed by the clock, since each move is a round trip of unknown length.
 */
async function glide(win: Page, from: Point, to: Point): Promise<void> {
  const duration = Math.min(900, 350 + Math.hypot(to.x - from.x, to.y - from.y) * 0.8)
  const start = Date.now()
  for (let t = 0; t < 1; ) {
    t = Math.min((Date.now() - start) / duration, 1)
    const s = t ** 3 * (10 - 15 * t + 6 * t ** 2)
    await win.mouse.move(from.x + (to.x - from.x) * s, from.y + (to.y - from.y) * s)
    await sleep(8)
  }
}

/** Runs the storyboard in order against the live window; `crop` enables camera cuts. */
async function play(
  app: ElectronApplication,
  win: Page,
  steps: Step[],
  crop: Box | undefined,
  pointer: Point | undefined
): Promise<Played> {
  const sent = () => app.evaluate(() => (globalThis as unknown as { loomboxSent: string[] }).loomboxSent.slice())
  const stream = { from: Infinity, to: -Infinity }
  const shots: Shot[] = [{ at: 0 }]
  // An action shot frames whatever its steps touch, measured as they happen.
  const touch = async (target: Locator) => {
    const found = await box(target)
    shots.at(-1)!.boxes?.push(found)
    return found
  }
  // With a pointer on screen, a click is a glide to the target, a short aim, then the press.
  const click = async (target: Locator) => {
    const found = await touch(target)
    if (pointer === undefined) return target.click()
    const to = { x: found.x + found.width / 2, y: found.y + found.height / 2 }
    await glide(win, pointer, to)
    pointer = to
    await sleep(AIM_MS)
    await target.click({ delay: PRESS_MS })
  }
  let session: Session | undefined
  for (const step of steps) {
    await sleep(step.after)
    switch (step.kind) {
      case 'click':
        await click(step.target(win))
        break
      case 'type':
        await touch(step.target(win))
        await step.target(win).pressSequentially(step.text, { delay: TYPE_DELAY_MS })
        break
      case 'send': {
        const before = (await sent()).length
        if (step.by === 'click') await click(step.target(win))
        else {
          await touch(step.target(win))
          await step.target(win).press('Enter')
        }
        await expect.poll(async () => (await sent()).length).toBeGreaterThan(before)
        const id = (await sent()).at(-1)!
        const workspace = await workspaceOf(win, id)
        session = { id, workspaceId: workspace.id, worktree: workspace.worktreePath }
        await blur(win)
        break
      }
      case 'wait':
        await expect(step.target(win)).toBeVisible({ timeout: 30000 })
        await touch(step.target(win))
        break
      case 'emit':
        if (session === undefined) throw new Error('an emit step ran before any send')
        await emit(app, session, 'at' in step.event ? { ...step.event, at: Date.now() } : step.event)
        if (step.event.type === 'text.delta') {
          stream.from = Math.min(stream.from, Date.now())
          stream.to = Date.now()
        }
        break
      case 'write':
        if (session === undefined) throw new Error('a write step ran before any send')
        writeChange(session.worktree, step.file, step.text)
        break
      case 'camera':
        if (crop === undefined) throw new Error('a camera cut in a whole-window video')
        shots.push(step.shot === 'home' ? { at: Date.now() } : { at: Date.now(), boxes: [] })
        break
    }
  }
  if (crop === undefined) return { stream, camera: [] }
  const view = await win.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }))
  return { stream, camera: shots.map((shot) => ({ at: shot.at, ...fit(shot.boxes, crop, view) })) }
}

/** Screencasts the window while `scene` runs; frames go to `dir` with their paint times. */
async function record<T>(win: Page, dir: string, scene: () => Promise<T>): Promise<[Frame[], T]> {
  const frames: Frame[] = []
  const cdp = await win.context().newCDPSession(win)
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    void cdp.send('Page.screencastFrameAck', { sessionId })
    const file = path.join(dir, `${String(frames.length).padStart(5, '0')}.png`)
    writeFileSync(file, data, 'base64')
    frames.push({ file, at: (metadata.timestamp ?? Date.now() / 1000) * 1000 })
  })
  await cdp.send('Page.startScreencast', { format: 'png' })
  await expect.poll(() => frames.length).toBeGreaterThan(0)
  const result = await scene()
  const end = Date.now()
  await cdp.send('Page.stopScreencast')
  await cdp.detach()
  // A still screen paints nothing, so the last frame must be held until the scene ended.
  const last = frames.at(-1)!
  if (end > last.at) frames.push({ file: last.file, at: end })
  return [frames, result]
}

/** Only gaps between two streaming frames count; the idle before the first delta is not stutter. */
function assertSmooth(frames: Frame[], stream: Played['stream']): void {
  const streaming = frames.filter((frame) => frame.at >= stream.from && frame.at <= stream.to)
  const gaps = streaming.slice(1).map((frame, i) => frame.at - streaming[i]!.at)
  expect(Math.max(0, ...gaps), 'recording stuttered while text streamed').toBeLessThanOrEqual(MAX_STREAM_GAP_MS)
}

type Film = {
  name: string
  /** Fixture variant: `live` leaves the search session empty for the video to fill. */
  live: boolean
  steps: Step[]
  loop: Loop
  /** Output width when filming the whole window. */
  width?: number
  /** A fixed crop the camera pans across; omit to film the whole window. */
  frame?: (win: Page) => Promise<Box>
  /** Resolves once the final state is on screen. */
  done?: (win: Page) => Promise<void>
  /** How long the final state stays before the loop closes, in ms. */
  hold?: number
  /** Draw a mouse pointer resting here (fractions of the frame), for videos driven by clicks. */
  pointer?: { x: number; y: number }
  /** Size budget for the encoded video. */
  maxBytes?: number
  /** Whether the page shows this video's first frame as a still; default yes. */
  poster?: boolean
}

/** Builds the demo, plays the storyboard with the agent stubbed out, and writes `<name>.mp4`. */
export async function film(spec: Film): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  const dir = mkdtempSync(path.join(os.tmpdir(), `loombox-${spec.name}-`))
  const app = await launchDemo(buildFixture({ live: spec.live }))
  try {
    const win = await demoWindow(app)
    await openSearchSession(win)
    await stubAgent(app, win)
    await assertNothingPersonal(win)
    const crop = await spec.frame?.(win)
    const frame = crop ?? (await win.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight })))
    const rest = spec.pointer && { x: frame.x + frame.width * spec.pointer.x, y: frame.y + frame.height * spec.pointer.y }
    if (rest) await showPointer(win, rest)
    const [frames, played] = await record(win, dir, async () => {
      const played = await play(app, win, spec.steps, crop, rest)
      await spec.done?.(win)
      await sleep(spec.hold ?? SETTLE_MS)
      return played
    })
    await assertNothingPersonal(win)
    assertSmooth(frames, played.stream)
    // Frames are device pixels; the window and the camera were measured in CSS pixels.
    const scale = await win.evaluate(() => devicePixelRatio)
    const camera = crop && {
      width: crop.width * scale,
      height: crop.height * scale,
      keys: played.camera.map((key) => ({ ...key, cx: key.cx * scale, cy: key.cy * scale }))
    }
    encodeVideo(frames, SHOTS, { name: spec.name, loop: spec.loop, width: spec.width, camera, maxBytes: spec.maxBytes, poster: spec.poster })
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
